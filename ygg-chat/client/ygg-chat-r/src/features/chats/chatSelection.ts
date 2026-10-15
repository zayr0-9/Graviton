import { createAction } from '@reduxjs/toolkit'
import type { ConversationId, MessageId } from '../../../../../shared/types'
import type { LineageId, Message, StreamState } from './chatTypes'
import { buildBranchPathForMessage } from './pathUtils'

interface ChatDestination {
  conversationId: ConversationId
  projectId?: string | null
  storageMode?: 'local' | 'cloud'
}

export type ChatSelectionTarget = ChatDestination & (
  | { kind: 'conversation' }
  | { kind: 'lineage'; lineageId: LineageId; messageId?: MessageId | null }
  | { kind: 'message'; messageId: MessageId; path?: MessageId[] }
)

export interface ResolvedChatSelection {
  conversationId: ConversationId
  lineageId: LineageId | null
  path: MessageId[]
  focus: MessageId | null
}

export interface ChatSelectionState {
  revision: number
  /** Changes only when the resolved view changes; same-view refocus retains startup ownership. */
  fallbackRevision: number
  requestId: string | null
  target: ChatSelectionTarget | null
  source: string | null
  status: 'idle' | 'pending' | 'ready' | 'error'
  error: string | null
  scroll: { requestId: string; focus: MessageId | null; mode: 'focus' | 'latest' } | null
}

export const initialChatSelection = (): ChatSelectionState => ({
  revision: 0, fallbackRevision: 0, requestId: null, target: null, source: null, status: 'idle', error: null, scroll: null,
})

// Shared actions let both conversation slices observe one selection transaction without imports
// between reducers. Requests are renderer-local; no route state or AbortController is persisted.
export const chatSelectionRequested = createAction<{
  requestId: string; target: ChatSelectionTarget; source: string
}>('chat/selectionRequested')
export const chatSelectionCommitted = createAction<ResolvedChatSelection & {
  requestId: string; error?: string; scrollMode?: 'focus' | 'latest' | 'none'
}>('chat/selectionCommitted')
export const chatSelectionFailed = createAction<{ requestId: string; error: string }>('chat/selectionFailed')
// Recovery of the same intent is not navigation: preserve revision and stream ownership.
export const chatSelectionResumed = createAction<{ requestId: string }>('chat/selectionResumed')
export const chatSelectionCancelled = createAction('chat/selectionCancelled')
export const chatSelectionScrollHandled = createAction<string>('chat/selectionScrollHandled')

const encode = (value: string) => encodeURIComponent(value)
const decode = (value: string): string | null => {
  try { return decodeURIComponent(value) || null } catch { return null }
}

export function getChatSelectionHref(target: ChatSelectionTarget): string {
  const base = `/chat/${encode(target.projectId || 'unknown')}/${encode(String(target.conversationId))}`
  if (target.kind === 'lineage') {
    const route = `${base}/lineage/${encode(target.lineageId)}`
    return target.messageId ? `${route}?focus=${encode(String(target.messageId))}` : route
  }
  return target.kind === 'message' ? `${base}#${encode(String(target.messageId))}` : base
}

/** Only absolute in-app chat routes are selections; Markdown section anchors are not. */
export function parseChatSelectionHref(href: string, storageMode?: 'local' | 'cloud'): ChatSelectionTarget | null {
  const match = /^\/chat\/([^/?#]+)\/([^/?#]+)(?:\/lineage\/([^/?#]+))?\/?(\?[^#]*)?(#.*)?$/.exec(href)
  if (!match) return null
  const projectId = decode(match[1])
  const conversationId = decode(match[2])
  if (!projectId || !conversationId) return null
  const base = { projectId, conversationId, storageMode }
  if (match[3]) {
    const lineageId = decode(match[3])
    if (!lineageId) return null
    return { ...base, kind: 'lineage', lineageId, messageId: new URLSearchParams(match[4] || '').get('focus') || null }
  }
  if (match[5]?.length > 1) {
    const messageId = decode(match[5].slice(1))
    return messageId ? { ...base, kind: 'message', messageId } : null
  }
  return { ...base, kind: 'conversation' }
}

export function isValidSelectionPath(messages: readonly Message[], path: readonly MessageId[]): boolean {
  if (!path.length) return messages.length === 0
  const byId = new Map(messages.map(message => [String(message.id), message]))
  const seen = new Set<string>()
  return path.every((id, index) => {
    const key = String(id)
    const row = byId.get(key)
    if (!row || seen.has(key)) return false
    seen.add(key)
    return index === 0 ? row.parent_id == null : String(row.parent_id) === String(path[index - 1])
  })
}

export function resolveLocalChatSelection(
  target: ChatSelectionTarget,
  messages: readonly Message[],
  current: ResolvedChatSelection
): ResolvedChatSelection | null {
  const rows = messages.filter(message => String(message.conversation_id) === String(target.conversationId))
  if (target.kind === 'lineage') return null
  if (target.kind === 'message') {
    const row = rows.find(message => String(message.id) === String(target.messageId))
    if (!row) return null
    const hint = target.path
    const path = hint?.some(id => String(id) === String(row.id)) && isValidSelectionPath(rows, hint)
      ? hint : buildBranchPathForMessage(rows, row.id)
    if (!isValidSelectionPath(rows, path)) return null
    const samePath = current.path.length === path.length && current.path.every((id, i) => String(id) === String(path[i]))
    return { conversationId: target.conversationId, lineageId: samePath ? current.lineageId : null, path, focus: row.id }
  }
  if (String(current.conversationId) === String(target.conversationId) && current.path.length && isValidSelectionPath(rows, current.path)) {
    return current
  }
  const latest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  return {
    conversationId: target.conversationId, lineageId: null,
    path: latest ? buildBranchPathForMessage(rows, latest.id) : [], focus: null,
  }
}

export interface PendingViewStream {
  streamId: string
  conversationId: ConversationId
  selectionRevision: number
}

export function isPendingViewStreamOwned(
  owner: PendingViewStream | null,
  conversationId: ConversationId | null,
  selection: ChatSelectionState,
  stream: StreamState | null | undefined
): boolean {
  return Boolean(owner && selection.status !== 'pending' && selection.status !== 'error' && owner.selectionRevision === selection.fallbackRevision &&
    String(owner.conversationId) === String(conversationId) && stream?.active &&
    String(stream.conversationId) === String(conversationId))
}

/** Per-provider route event gate; no process-global navigation or permanent URL deduplication. */
export function createChatRouteGate() {
  let lastEvent: string | null = null
  const outgoing = new Map<string, string>()
  return {
    expect(requestId: string, href: string) {
      outgoing.set(requestId, href)
      if (outgoing.size > 32) outgoing.delete(outgoing.keys().next().value!)
    },
    consume(key: string, href: string, requestId?: string): boolean {
      const event = `${key}:${href}`
      if (lastEvent === event) return false
      lastEvent = event
      if (requestId && outgoing.get(requestId) === href) {
        outgoing.delete(requestId)
        return false
      }
      return true
    },
  }
}
