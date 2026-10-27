import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { executionPathAfterHandoff } from '../../../../../shared/summaryHandoff'
import { isClaudeProvider } from '../../../../../shared/claudeProvider'
import { branchModelKey, isProviderHandoffEdit, resolveComposerModelSelection, resolveClaudeBranchLock, resolveSummaryContinuation } from './branchModelSelection'
import type { ChatState } from './chatTypes'

/** Resolve the send's captured branch, never another pane's current selection. */
export function resolveBranchToolApproval(
  chat: ChatState,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
  lineageId = chat.conversation.currentLineageId,
): boolean {
  const draft = lineageId ? chat.branchToolApprovalDrafts?.[branchModelKey(conversationId, `lineage:${lineageId}`)] : undefined
  if (typeof draft === 'boolean') return draft
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const executionPath = executionPathAfterHandoff(path.map(id => messages.get(String(id))).filter((row): row is NonNullable<typeof row> => Boolean(row)))
  const ids = path.length ? executionPath.map(row => row.id).reverse() : [null]
  for (const id of ids) {
    const anchored = chat.branchToolApprovalDrafts?.[branchModelKey(conversationId, id)]
    if (typeof anchored === 'boolean') return anchored
    const row = messages.get(String(id))
    if (row && String(row.conversation_id) !== String(conversationId)) continue
    const recorded = parseMessageMeta(row?.meta)?.toolAutoApprove
    if (typeof recorded === 'boolean') return recorded
  }
  return chat.toolAutoApprove
}

/** Fork/edit policies inherit from the cut, not later work or the source's live draft. */
export function resolveAnchoredToolApproval(chat: ChatState, anchorId: unknown, conversationId: unknown): boolean {
  const rows = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const path: string[] = []
  const seen = new Set<string>()
  let cursor = anchorId == null ? null : String(anchorId)
  while (cursor != null) {
    if (seen.has(cursor)) return chat.toolAutoApprove
    seen.add(cursor)
    const row = rows.get(cursor)
    if (!row || String(row.conversation_id) !== String(conversationId)) return chat.toolAutoApprove
    path.unshift(cursor)
    cursor = row.parent_id == null ? null : String(row.parent_id)
  }
  return resolveBranchToolApproval(chat, path, String(conversationId), null)
}

export function composerApprovalHandoff(chat: ChatState) {
  const provider = resolveComposerModelSelection(chat)?.provider ?? chat.providerState.currentProvider
  return isClaudeProvider(provider) && !resolveClaudeBranchLock(chat) ? resolveSummaryContinuation(chat) : null
}

export function resolveHandoffToolApproval(chat: ChatState, summaryId: unknown): boolean {
  return chat.branchToolApprovalDrafts?.[branchModelKey(chat.conversation.currentConversationId, `handoff:${summaryId}`)] ?? chat.toolAutoApprove
}

export function resolveComposerToolApproval(chat: ChatState): boolean {
  if (chat.composition.editingBranch) {
    const explicit = chat.composition.branchEditModes?.toolAutoApprove
    if (typeof explicit === 'boolean') return explicit
    if (isProviderHandoffEdit(chat)) return chat.toolAutoApprove
    const source = chat.conversation.messages.find(row => String(row.id) === String(chat.composition.branchEditMessageId))
    return resolveAnchoredToolApproval(chat, source?.parent_id, chat.conversation.currentConversationId)
  }
  const handoff = composerApprovalHandoff(chat)
  if (handoff) return resolveHandoffToolApproval(chat, handoff.id)
  return resolveBranchToolApproval(chat)
}

const STORAGE_KEY = 'chat:branchToolApprovalDrafts'
export function loadBranchToolApprovalDrafts(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean')) as Record<string, boolean>
  } catch { return {} }
}

export function saveBranchToolApprovalDrafts(drafts: Record<string, boolean>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts)) }
  catch (error) { console.warn('Unable to save branch tool approval selections', error) }
}
