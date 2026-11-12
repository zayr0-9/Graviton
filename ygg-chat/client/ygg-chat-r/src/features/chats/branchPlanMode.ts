import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { branchModelKey } from './branchModelSelection'
import type { ChatState } from './chatTypes'

/**
 * Claude Code native plan mode for the selected branch, so the composer shows each branch's own
 * state when the user navigates. Walking up from the tip, the first of these decides:
 * - a composer choice (Plan toggle or /plan) made at that point of the branch;
 * - a Claude row there. Every Claude user and response row records `operationMode`, and records
 *   `claudePlanMode` while plan mode is on, so a row without it means off. A response written after
 *   the user approved the plan therefore reads as off.
 * Unlike Fast mode there is no lineage-wide choice: an approved plan must end plan mode for the
 * rest of the lineage, and a lineage choice would outrank the rows that record it.
 */
export function resolveBranchPlanMode(
  chat: ChatState,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
): boolean {
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const ancestry: Array<string | null> = path.length ? [...path].map(String).reverse() : [null]
  for (const id of ancestry) {
    const draft = chat.claudePlanModeDrafts?.[branchModelKey(conversationId, id)]
    if (typeof draft === 'boolean') return draft
    const meta = parseMessageMeta(messages.get(String(id))?.meta)
    if (meta?.operationMode === 'plan' || meta?.operationMode === 'execute') return meta.claudePlanMode === true
  }
  return false
}

const DRAFT_STORAGE_KEY = 'chat:claudePlanModeDrafts'
// Choices are kept per branch point; the oldest go first once there are more than this.
const MAX_DRAFTS = 200

export function loadClaudePlanModeDrafts(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean')) as Record<string, boolean>
  } catch { return {} }
}

export function saveClaudePlanModeDrafts(drafts: Record<string, boolean>): void {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)) }
  catch (error) { console.warn('Unable to save Claude plan mode selections', error) }
}

/** Records a per-branch-point choice, newest last so the store drops the oldest. */
export function withClaudePlanModeDraft(drafts: Record<string, boolean> | undefined, key: string, enabled: boolean): Record<string, boolean> {
  const next = { ...(drafts ?? {}) }
  delete next[key]
  next[key] = enabled
  const entries = Object.entries(next)
  return entries.length > MAX_DRAFTS ? Object.fromEntries(entries.slice(-MAX_DRAFTS)) : next
}
