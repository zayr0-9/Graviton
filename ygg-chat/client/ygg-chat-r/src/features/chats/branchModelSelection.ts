import { executionPathAfterHandoff, portableSummaryText } from '../../../../../shared/summaryHandoff'
import { isCleanStartUserBranch } from '../../../../../shared/cleanStartBranch'
import { isClaudeProvider } from '../../../../../shared/claudeProvider'
import { isTransferredMessage } from '../../../../../shared/claudeTransfer'
import { isRunSettingsNotification } from '../../../../../shared/accessNotifications'
import { isContextInjectionMessage, parseMessageMeta } from '../../../../../shared/contextInjection'
import type { ChatState } from './chatTypes'

export interface BranchModelSelection { provider: string; model: string | null }

export const branchModelKey = (conversationId: unknown, tip: unknown) =>
  JSON.stringify([String(conversationId), tip == null ? null : String(tip)])

const providerKey = (name: string) => {
  const key = name.toLowerCase().replace(/[\s().-]/g, '')
  return key === 'google' ? 'gemini' : key === 'awsbedrock' || key === 'amazonbedrock' ? 'bedrock' : key === 'glm' ? 'zai' : key
}

/** Resolve only the selected ancestry. Metadata never becomes an instruction to the model.
 * A Claude branch fixes only its provider: Claude-model drafts still apply, other providers' never do. */
export function resolveBranchModelSelection(
  chat: ChatState,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
  lineageId = chat.conversation.currentLineageId,
): BranchModelSelection | null {
  const locked = resolveSummaryContinuation(chat, path) ? null : resolveClaudeBranchLock(chat, path)
  const lineageDraft = lineageId ? chat.branchModelDrafts?.[branchModelKey(conversationId, `lineage:${lineageId}`)] : null
  if (lineageDraft && (!locked || isClaudeProvider(lineageDraft.provider)) &&
    chat.providerState.providers.some(item => item.name === lineageDraft.provider)) return lineageDraft
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const ancestry: Array<string | null> = path.length ? [...path].reverse() : [null]
  for (const id of ancestry) {
    const draft = chat.branchModelDrafts?.[branchModelKey(conversationId, id)]
    const recorded = parseMessageMeta(messages.get(String(id))?.meta)?.modelSelection as BranchModelSelection | undefined
    const selection = draft ?? recorded
    if (!selection || typeof selection.provider !== 'string' || (locked && !isClaudeProvider(selection.provider))) continue
    const provider = chat.providerState.providers.find(item => providerKey(item.name) === providerKey(selection.provider))?.name
    if (!provider) continue
    return { provider, model: typeof selection.model === 'string' ? selection.model : null }
  }
  return locked
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

/** Persisted Claude provider wins over other providers' renderer-local drafts. The model is the nearest recorded one. */
export function resolveClaudeBranchLock(chat: ChatState, path = chat.conversation.currentPath): BranchModelSelection | null {
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const rows = executionPathAfterHandoff(path.map(id => messages.get(String(id))).filter((row): row is NonNullable<typeof row> => Boolean(row)))
  for (const row of [...rows].reverse()) {
    const pair = parseMessageMeta(row.meta)?.modelSelection as BranchModelSelection | undefined
    if (pair && isClaudeProvider(pair.provider)) return { provider: 'Claude Code', model: pair.model }
  }
  return null
}

/** Replacing a first prompt may reset execution, but hiding a node never grants that permission. */
export function isCleanStartBranchEdit(
  chat: { conversation: Pick<ChatState['conversation'], 'currentConversationId' | 'messages'>; composition?: Pick<ChatState['composition'], 'branchEditMessageId'> },
  messageId: unknown = chat.composition?.branchEditMessageId,
): boolean {
  if (messageId == null) return false
  const messages = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const path = []
  const seen = new Set<string>()
  let cursor: string | null = String(messageId)
  while (cursor !== null) {
    if (seen.has(cursor)) return false
    seen.add(cursor)
    const row = messages.get(cursor)
    if (!row || String(row.conversation_id) !== String(chat.conversation.currentConversationId)) return false
    path.unshift(row)
    cursor = row.parent_id == null ? null : String(row.parent_id)
  }
  return isCleanStartUserBranch(path)
}

/** Editor-local choices must never overwrite the source lineage's draft or native identity. */
export function resolveEditBranchModelSelection(chat: ChatState, messageId: unknown): BranchModelSelection | null {
  if (chat.composition?.editingBranch && String(chat.composition.branchEditMessageId) === String(messageId)) {
    const draft = chat.composition.branchEditModelSelection
    const lock = resolveClaudeBranchLock(chat)
    if (draft && (!lock || isClaudeProvider(draft.provider) || isProviderHandoffEdit(chat, messageId))) return draft
  }
  return resolveBranchModelSelection(chat)
}

export function resolveComposerModelSelection(chat: ChatState): BranchModelSelection | null {
  return chat.composition?.editingBranch
    ? resolveEditBranchModelSelection(chat, chat.composition.branchEditMessageId)
    : resolveBranchModelSelection(chat)
}

/** A committed summary is a handoff boundary in both directions until real work follows it. */
export function resolveComposerClaudeLock(chat: ChatState): BranchModelSelection | null {
  if (chat.composition?.editingBranch) return isProviderHandoffEdit(chat) ? null : resolveClaudeBranchLock(chat)
  return resolveSummaryContinuation(chat) ? null : resolveClaudeBranchLock(chat)
}

/** Crossing the Claude boundary from an idle summary tip needs a fresh execution: same-family sends just continue.
 * A summary copied from another chat has no session here, so every send from it is a fresh execution. */
export function resolveComposerSummaryHandoff(chat: ChatState, provider: string | null | undefined, path = chat.conversation.currentPath) {
  const summary = resolveSummaryContinuation(chat, path)
  if (summary && isTransferredMessage(summary)) return summary
  return isClaudeProvider(provider) !== Boolean(resolveClaudeBranchLock(chat, path)) ? summary : null
}

export function isSummaryBranchEdit(chat: Pick<ChatState, 'conversation' | 'composition'>, messageId: unknown = chat.composition?.branchEditMessageId): boolean {
  const row = chat.conversation.messages.find(row => String(row.id) === String(messageId))
  return Boolean(row && String(row.conversation_id) === String(chat.conversation.currentConversationId) && portableSummaryText(row))
}

export function isProviderHandoffEdit(chat: ChatState, messageId: unknown = chat.composition?.branchEditMessageId): boolean {
  if (isSummaryBranchEdit(chat, messageId) || isCleanStartBranchEdit(chat, messageId)) return true
  const rows = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  const source = rows.get(String(messageId))
  if (!source || source.role !== 'user' || String(source.conversation_id) !== String(chat.conversation.currentConversationId)) return false
  const handoffId = (parseMessageMeta(source.meta)?.executionHandoff as { summaryMessageId?: string } | undefined)?.summaryMessageId
  const seen = new Set<string>()
  let cursor = source.parent_id
  while (cursor != null && !seen.has(String(cursor))) {
    seen.add(String(cursor))
    const row = rows.get(String(cursor))
    if (!row || String(row.conversation_id) !== String(chat.conversation.currentConversationId)) return false
    if (portableSummaryText(row)) return !handoffId || String(handoffId) === String(row.id)
    if (handoffId) { cursor = row.parent_id; continue }
    if (!isContextInjectionMessage(row) && !isRunSettingsNotification(row)) return false
    cursor = row.parent_id
  }
  return false
}

/** The idle composer may hand off before any real post-summary work has occurred. */
export function resolveSummaryContinuation(chat: Pick<ChatState, 'conversation'>, path = chat.conversation.currentPath) {
  const rows = new Map(chat.conversation.messages.map(row => [String(row.id), row]))
  let child: (typeof chat.conversation.messages)[number] | undefined
  for (let index = path.length - 1; index >= 0; index--) {
    const row = rows.get(String(path[index]))
    if (!row || String(row.conversation_id) !== String(chat.conversation.currentConversationId) ||
      (child && String(child.parent_id) !== String(row.id))) return null
    if (portableSummaryText(row)) return row
    if (!isContextInjectionMessage(row) && !isRunSettingsNotification(row) &&
      parseMessageMeta(row.meta)?.kind !== 'compaction_resume') return null
    child = row
  }
  return null
}
