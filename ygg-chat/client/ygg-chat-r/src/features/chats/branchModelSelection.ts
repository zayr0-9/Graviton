import { parseMessageMeta } from '../../../../../shared/contextInjection'
import type { ChatState } from './chatTypes'

export interface BranchModelSelection { provider: string; model: string | null }

export const branchModelKey = (conversationId: unknown, tip: unknown) =>
  JSON.stringify([String(conversationId), tip == null ? null : String(tip)])

const providerKey = (name: string) => {
  const key = name.toLowerCase().replace(/[\s().-]/g, '')
  return key === 'google' ? 'gemini' : key === 'awsbedrock' || key === 'amazonbedrock' ? 'bedrock' : key === 'glm' ? 'zai' : key
}

/** Resolve only the selected ancestry. Metadata never becomes an instruction to the model. */
export function resolveBranchModelSelection(
  chat: ChatState,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
  lineageId = chat.conversation.currentLineageId,
): BranchModelSelection | null {
  const lineageDraft = lineageId ? chat.branchModelDrafts?.[branchModelKey(conversationId, `lineage:${lineageId}`)] : null
  if (lineageDraft && chat.providerState.providers.some(item => item.name === lineageDraft.provider)) return lineageDraft
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const ancestry: Array<string | null> = path.length ? [...path].reverse() : [null]
  for (const id of ancestry) {
    const draft = chat.branchModelDrafts?.[branchModelKey(conversationId, id)]
    const recorded = parseMessageMeta(messages.get(String(id))?.meta)?.modelSelection as BranchModelSelection | undefined
    const selection = draft ?? recorded
    if (!selection || typeof selection.provider !== 'string') continue
    const provider = chat.providerState.providers.find(item => providerKey(item.name) === providerKey(selection.provider))?.name
    if (!provider) continue
    return { provider, model: typeof selection.model === 'string' ? selection.model : null }
  }
  return null
}

const DRAFT_STORAGE_KEY = 'chat:branchModelDrafts'
export function loadBranchModelDrafts(): Record<string, BranchModelSelection> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
      const pair = entry as BranchModelSelection | null
      return pair && typeof pair.provider === 'string' && (pair.model === null || typeof pair.model === 'string')
    })) as Record<string, BranchModelSelection>
  } catch { return {} }
}

export function saveBranchModelDrafts(drafts: Record<string, BranchModelSelection>): void {
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)) }
  catch (error) { console.warn('Unable to save branch model selections', error) }
}
