import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { branchModelKey } from './branchModelSelection'
import { withClaudePlanModeDraft } from './branchPlanMode'
import type { ChatState } from './chatTypes'

/**
 * Claude Code auto mode (Ask → Auto) for the selected branch. Walking up from the tip, the first of
 * these decides:
 * - a composer choice made at that point of the branch;
 * - a Claude response row recording `claudePermissionMode` ('auto' or 'default'). An approved
 *   ExitPlanMode switches its run to auto, so the rows after it keep the branch in auto mode.
 * Otherwise the session's launch default (`chat.claudeAutoMode`). Allow all is separate
 * (branch tool approval) and outranks this when on.
 */
export function resolveBranchClaudeAutoMode(
  chat: ChatState,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
): boolean {
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const ancestry: Array<string | null> = path.length ? [...path].map(String).reverse() : [null]
  for (const id of ancestry) {
    const draft = chat.claudeAutoModeDrafts?.[branchModelKey(conversationId, id)]
    if (typeof draft === 'boolean') return draft
    const recorded = parseMessageMeta(messages.get(String(id))?.meta)?.claudePermissionMode
    if (recorded === 'auto' || recorded === 'default') return recorded === 'auto'
  }
  return chat.claudeAutoMode === true
}

/** Fork/edit sends resolve at their cut, like branch tool approval. */
export function resolveAnchoredClaudeAutoMode(chat: ChatState, anchorId: unknown, conversationId: unknown): boolean {
  const rows = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const path: string[] = []
  const seen = new Set<string>()
  let cursor = anchorId == null ? null : String(anchorId)
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor)
    const row = rows.get(cursor)
    if (!row || String(row.conversation_id) !== String(conversationId)) break
    path.unshift(cursor)
    cursor = row.parent_id == null ? null : String(row.parent_id)
  }
  return resolveBranchClaudeAutoMode(chat, path, String(conversationId))
}

const DRAFT_STORAGE_KEY = 'chat:claudeAutoModeDrafts'

export function loadClaudeAutoModeDrafts(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean')) as Record<string, boolean>
  } catch { return {} }
}

export function saveClaudeAutoModeDrafts(drafts: Record<string, boolean>): void {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)) }
  catch (error) { console.warn('Unable to save Claude auto mode selections', error) }
}

export const withClaudeAutoModeDraft = withClaudePlanModeDraft
