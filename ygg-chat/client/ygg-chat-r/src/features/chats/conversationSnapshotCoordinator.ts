import type { QueryClient } from '@tanstack/react-query'
import type { ConversationId, MessageId } from '../../../../../shared/types'
import type { RootState } from '../../store/store'
import { chatSliceActions } from './chatSlice'
import type { ConversationMessagesTreeData } from './conversationMessagesApi'
import { fetchConversationMessagesTree } from './conversationMessagesApi'
import { conversationQueryKeys, normalizeConversationId } from './conversationQueryKeys'
import { reconcileConversationSnapshot, type ConversationSnapshotProtection } from './conversationSnapshotReconciliation'
import { buildConversationTree } from './conversationTree'

export interface TerminalSnapshotLease {
  conversationId: string
  streamId: string
  generation: number
  messageIds: string[]
}

const requestGenerations = new Map<string, number>()
const requestControllers = new Map<string, AbortController>()
const terminalLeases = new Map<string, TerminalSnapshotLease>()
const terminalGenerations = new Map<string, number>()

const leaseKey = (conversationId: ConversationId | string, streamId: string): string =>
  `${normalizeConversationId(conversationId)}:${streamId}`

export function recordTerminalSnapshotLease(input: {
  conversationId: ConversationId | string
  streamId: string
  messageIds: Array<MessageId | string | null | undefined>
}): TerminalSnapshotLease {
  const conversationId = normalizeConversationId(input.conversationId)
  const key = leaseKey(conversationId, input.streamId)
  const generation = (terminalGenerations.get(key) ?? 0) + 1
  terminalGenerations.set(key, generation)
  const lease = {
    conversationId,
    streamId: input.streamId,
    generation,
    messageIds: [...new Set(input.messageIds.filter((id): id is MessageId | string => id != null).map(String))],
  }
  terminalLeases.set(key, lease)
  return lease
}

export function getTerminalSnapshotLeases(conversationId: ConversationId | string): TerminalSnapshotLease[] {
  const normalized = normalizeConversationId(conversationId)
  return [...terminalLeases.values()].filter(lease => lease.conversationId === normalized)
}

export function clearConversationSnapshotCoordinatorForTests(): void {
  requestGenerations.clear()
  for (const controller of requestControllers.values()) controller.abort()
  requestControllers.clear()
  terminalLeases.clear()
  terminalGenerations.clear()
}

function activeProtections(state: RootState, conversationId: string): ConversationSnapshotProtection[] {
  return state.chat.streaming.activeIds.flatMap(streamId => {
    const stream = state.chat.streaming.byId[streamId]
    if (!stream?.active || stream.conversationId == null || String(stream.conversationId) !== conversationId) return []
    return [{
      messageIds: [
        stream.messageId,
        stream.triggerUserMessageId,
        stream.currentBranchAnchorMessageId,
        stream.branchAnchorMessageId,
        stream.liveMessageId,
        stream.lastCompletedMessageId,
        stream.finalMessageId,
        stream.streamingMessageId,
        stream.lineage.rootMessageId,
        stream.lineage.originMessageId,
      ].filter((id): id is MessageId => id != null).map(String),
    }]
  })
}

export interface CoordinateConversationSnapshotOptions {
  conversationId: ConversationId
  storageMode?: 'local' | 'cloud'
  accessToken?: string | null
  queryClient: QueryClient
  getState: () => RootState
  dispatch: (action: ReturnType<typeof chatSliceActions.conversationSnapshotApplied>) => unknown
  fetchSnapshot?: typeof fetchConversationMessagesTree
}

export interface CoordinateConversationSnapshotResult {
  accepted: boolean
  generation: number
  data?: ConversationMessagesTreeData
}

/** Fetches outside TanStack Query so rejected generations can never poison its cache. */
export async function coordinateConversationSnapshot({
  conversationId,
  storageMode,
  accessToken,
  queryClient,
  getState,
  dispatch,
  fetchSnapshot = fetchConversationMessagesTree,
}: CoordinateConversationSnapshotOptions): Promise<CoordinateConversationSnapshotResult> {
  const normalizedId = normalizeConversationId(conversationId)
  const generation = (requestGenerations.get(normalizedId) ?? 0) + 1
  requestGenerations.set(normalizedId, generation)
  requestControllers.get(normalizedId)?.abort()
  const controller = new AbortController()
  requestControllers.set(normalizedId, controller)

  try {
    const fetched = await fetchSnapshot(conversationId, {
      storageMode,
      accessToken,
      queryClient,
      signal: controller.signal,
    })
    if (controller.signal.aborted || requestGenerations.get(normalizedId) !== generation) {
      return { accepted: false, generation }
    }

    const state = getState()
    if (String(state.chat.conversation.currentConversationId ?? '') !== normalizedId) {
      return { accepted: false, generation }
    }

    const leases = getTerminalSnapshotLeases(normalizedId)
    const protections: ConversationSnapshotProtection[] = [
      ...activeProtections(state, normalizedId),
      ...leases.map(lease => ({ messageIds: lease.messageIds })),
    ]
    const messages = reconcileConversationSnapshot({
      fetchedMessages: fetched.messages ?? [],
      liveMessages: state.chat.conversation.messages,
      protections,
    })
    const data: ConversationMessagesTreeData = {
      ...fetched,
      messages,
      tree: buildConversationTree(messages),
    }

    // Check once more immediately before committing both accepted authorities.
    if (requestGenerations.get(normalizedId) !== generation ||
        String(getState().chat.conversation.currentConversationId ?? '') !== normalizedId) {
      return { accepted: false, generation }
    }

    queryClient.setQueryData(conversationQueryKeys.messages(normalizedId), data)
    dispatch(chatSliceActions.conversationSnapshotApplied({ conversationId, messages, tree: data.tree }))

    const fetchedIds = new Set((fetched.messages ?? []).map(message => String(message.id)))
    for (const lease of leases) {
      if (lease.messageIds.every(id => fetchedIds.has(id))) terminalLeases.delete(leaseKey(normalizedId, lease.streamId))
    }
    return { accepted: true, generation, data }
  } finally {
    if (requestControllers.get(normalizedId) === controller) requestControllers.delete(normalizedId)
  }
}
