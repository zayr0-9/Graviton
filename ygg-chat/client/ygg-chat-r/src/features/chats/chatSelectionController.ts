import type { ChatState } from './chatTypes'
import {
  chatSelectionCancelled, chatSelectionCommitted, chatSelectionFailed, chatSelectionRequested, chatSelectionResumed,
  isValidSelectionPath, resolveLocalChatSelection,
  type ChatSelectionTarget, type ResolvedChatSelection,
} from './chatSelection'

export interface LineageSelectionDetail {
  pathMessageIds?: string[]
  path?: Array<string | { id?: string }>
  head_message_id?: string | null
}

type SelectionAction = ReturnType<typeof chatSelectionRequested | typeof chatSelectionCommitted | typeof chatSelectionFailed | typeof chatSelectionResumed | typeof chatSelectionCancelled>

export function createChatSelectionController(deps: {
  getState: () => ChatState
  dispatch: (action: SelectionAction) => unknown
  loadLineage: (target: Extract<ChatSelectionTarget, { kind: 'lineage' }>, signal: AbortSignal) => Promise<LineageSelectionDetail>
  createRequestId?: () => string
}) {
  let pending: { id: string; abort: AbortController } | null = null
  const currentSelection = (): ResolvedChatSelection => {
    const { conversation } = deps.getState()
    return {
      conversationId: conversation.currentConversationId!, lineageId: conversation.currentLineageId,
      path: conversation.currentPath, focus: conversation.focusedChatMessageId,
    }
  }
  const request = (target: ChatSelectionTarget, source: string) => {
    pending?.abort.abort()
    pending = null
    const requestId = deps.createRequestId?.() ?? crypto.randomUUID()
    deps.dispatch(chatSelectionRequested({ requestId, target, source }))
    return requestId
  }
  const cancel = () => {
    pending?.abort.abort()
    pending = null
    deps.dispatch(chatSelectionCancelled())
  }
  const resolve = async (acceptedConversationId: string | null, refresh: () => Promise<unknown>) => {
    const { selection, conversation } = deps.getState()
    const target = selection.target
    const requestId = selection.requestId
    if ((selection.status !== 'pending' && selection.status !== 'error') || !target || !requestId || pending?.id === requestId) return
    if (String(target.conversationId) !== acceptedConversationId ||
        String(conversation.currentConversationId) !== acceptedConversationId ||
        String(conversation.snapshotConversationId) !== acceptedConversationId) return
    // A replacement snapshot can succeed after an earlier load failed. Resume the
    // same intent, rather than inventing navigation or weakening submission guards.
    if (selection.status === 'error') deps.dispatch(chatSelectionResumed({ requestId }))
    const abort = new AbortController()
    pending = { id: requestId, abort }
    const ownsRequest = () => {
      const state = deps.getState()
      return !abort.signal.aborted && state.selection.requestId === requestId && state.selection.status === 'pending' &&
        String(state.conversation.currentConversationId) === String(target.conversationId) &&
        String(state.conversation.snapshotConversationId) === String(target.conversationId)
    }
    try {
      let result: ResolvedChatSelection | null = null
      let error: string | undefined
      try {
        if (target.kind === 'lineage') {
          const detail = await deps.loadLineage(target, abort.signal)
          if (!ownsRequest()) return
          const path = (detail.pathMessageIds ?? detail.path?.map(row => typeof row === 'object' ? row.id : row) ?? [])
            .filter((id): id is string => id != null && String(id).length > 0).map(String)
          const valid = () => isValidSelectionPath(deps.getState().conversation.messages, path)
          if (!valid()) await refresh()
          if (!ownsRequest()) return
          if (!valid()) throw new Error('Lineage messages are unavailable')
          const requestedFocus = target.messageId == null ? null : String(target.messageId)
          result = {
            conversationId: target.conversationId, lineageId: target.lineageId, path,
            focus: requestedFocus && path.includes(requestedFocus) ? requestedFocus : path.at(-1) ?? null,
          }
        } else {
          result = resolveLocalChatSelection(target, deps.getState().conversation.messages, currentSelection())
          if (!result) {
            await refresh()
            if (!ownsRequest()) return
            result = resolveLocalChatSelection(target, deps.getState().conversation.messages, currentSelection())
          }
        }
        if (!result) error = 'The requested message is no longer available. Showing this conversation instead.'
      } catch (cause) {
        if (!ownsRequest()) return
        console.warn('[ChatSelection] Unable to resolve target:', cause)
        error = 'The requested branch could not be opened. Showing this conversation instead. Try the link again to retry.'
      }
      if (!ownsRequest()) return
      result ??= resolveLocalChatSelection({ ...target, kind: 'conversation' }, deps.getState().conversation.messages, currentSelection())
      if (!result) return
      deps.dispatch(chatSelectionCommitted({
        ...result, requestId, error,
        scrollMode: result.focus != null ? 'focus' : 'latest',
      }))
    } finally {
      if (pending?.abort === abort) pending = null
    }
  }
  const snapshotFailed = (conversationId: string, requestId: string | null) => {
    const { selection, conversation } = deps.getState()
    if (selection.status !== 'pending' || !requestId || selection.requestId !== requestId ||
        String(selection.target?.conversationId) !== conversationId || String(conversation.currentConversationId) !== conversationId) return
    pending?.abort.abort()
    pending = null
    deps.dispatch(chatSelectionFailed({ requestId,
      error: 'This conversation could not be loaded. Retry to load it again.' }))
  }
  // Teardown must abort owned work without cancelling another provider's selection.
  const dispose = () => { pending?.abort.abort(); pending = null }
  return { request, cancel, resolve, snapshotFailed, dispose }
}
