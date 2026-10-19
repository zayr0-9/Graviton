import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { branchModelKey } from './branchModelSelection'
import type { ChatState } from './chatTypes'

/** Resolve the selected branch only, including an explicit standard-tier (false) choice. */
export function resolveBranchFastMode(
  chat: ChatState,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
  lineageId = chat.conversation.currentLineageId,
): boolean {
  const lineageDraft = lineageId ? chat.branchFastModeDrafts?.[branchModelKey(conversationId, `lineage:${lineageId}`)] : undefined
  if (typeof lineageDraft === 'boolean') return lineageDraft
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const ancestry: Array<string | null> = path.length ? [...path].reverse() : [null]
  for (const id of ancestry) {
    const draft = chat.branchFastModeDrafts?.[branchModelKey(conversationId, id)]
    if (typeof draft === 'boolean') return draft
    const recorded = parseMessageMeta(messages.get(String(id))?.meta)?.fastMode
    if (typeof recorded === 'boolean') return recorded
  }
  // Do not use the old global toggle: it could belong to an unrelated branch.
  return false
}

const DRAFT_STORAGE_KEY = 'chat:branchFastModeDrafts'
export function loadBranchFastModeDrafts(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean')) as Record<string, boolean>
  } catch { return {} }
}

export function saveBranchFastModeDrafts(drafts: Record<string, boolean>): void {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)) }
  catch (error) { console.warn('Unable to save branch Fast mode selections', error) }
}
