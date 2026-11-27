import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { isReasoningLevel, type ReasoningLevel } from '../../../../../shared/reasoningLevel'
import { branchModelKey } from './branchModelSelection'
import type { ChatState } from './chatTypes'

/** Settings default used when the selected branch has no recorded or drafted level. */
export type ReasoningDefaults = { defaultThinkingEnabled: boolean; defaultReasoningEffort: Exclude<ReasoningLevel, 'off'> }

export const defaultReasoningLevel = (defaults: ReasoningDefaults): ReasoningLevel =>
  defaults.defaultThinkingEnabled ? defaults.defaultReasoningEffort : 'off'

/** Resolve the selected branch only: lineage draft, then tip-to-root drafts and recorded metadata. */
export function resolveBranchReasoning(
  chat: ChatState,
  defaults: ReasoningDefaults,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
  lineageId = chat.conversation.currentLineageId,
): ReasoningLevel {
  const lineageDraft = lineageId ? chat.branchReasoningDrafts?.[branchModelKey(conversationId, `lineage:${lineageId}`)] : undefined
  if (isReasoningLevel(lineageDraft)) return lineageDraft
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const ancestry: Array<string | null> = path.length ? [...path].reverse().map(String) : [null]
  for (const id of ancestry) {
    const draft = chat.branchReasoningDrafts?.[branchModelKey(conversationId, id)]
    if (isReasoningLevel(draft)) return draft
    const recorded = parseMessageMeta(messages.get(String(id))?.meta)?.reasoningLevel
    if (isReasoningLevel(recorded)) return recorded
  }
  return defaultReasoningLevel(defaults)
}

const DRAFT_STORAGE_KEY = 'chat:branchReasoningDrafts'
export function loadBranchReasoningDrafts(): Record<string, ReasoningLevel> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, level]) => isReasoningLevel(level))) as Record<string, ReasoningLevel>
  } catch { return {} }
}

export function saveBranchReasoningDrafts(drafts: Record<string, ReasoningLevel>): void {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)) }
  catch (error) { console.warn('Unable to save branch reasoning selections', error) }
}
