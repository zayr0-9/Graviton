import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { branchModelKey, branchSettingsTarget, lineageSettingsKey } from './branchModelSelection'
import { buildPathToConversationMessage } from './conversationTree'
import type { ChatState } from './chatTypes'

/** Mirrors Fast mode: a lineage draft wins, then the nearest recorded choice along the path. */
export function resolveBranchUltracode(
  chat: ChatState,
  path = chat.conversation.currentPath,
  conversationId = chat.conversation.currentConversationId,
  lineageId = chat.conversation.currentLineageId,
): boolean {
  if (conversationId == null) return false
  const target = branchSettingsTarget(chat, path, conversationId, lineageId)
  const draft = target.lineageId && !target.mismatch ? chat.claudeUltracodeDrafts?.[lineageSettingsKey(conversationId, target.lineageId)] : undefined
  if (typeof draft === 'boolean') return draft
  const rows = new Map(chat.conversation.messages.filter(row => String(row.conversation_id) === String(conversationId)).map(row => [String(row.id), row]))
  return readUltracodePath(chat, rows, path, conversationId)
}

function readUltracodePath(chat: ChatState, rows: Map<string, ChatState['conversation']['messages'][number]>, path: readonly unknown[], conversationId: unknown): boolean {
  for (const id of path.length ? [...path].reverse() : [null]) {
    const draft = chat.claudeUltracodeDrafts?.[branchModelKey(conversationId, id)]
    if (typeof draft === 'boolean') return draft
    const recorded = parseMessageMeta(rows.get(String(id))?.meta)?.claudeUltracode
    if (typeof recorded === 'boolean') return recorded
  }
  return false
}

export function resolveAnchoredUltracode(chat: ChatState, conversationId: unknown, anchor: unknown): boolean {
  if (conversationId == null || anchor == null) return false
  const messages = chat.conversation.messages.filter(row => String(row.conversation_id) === String(conversationId))
  const path = buildPathToConversationMessage(messages, String(anchor))
  return path.length > 0 && readUltracodePath(chat, new Map(messages.map(row => [String(row.id), row])), path, conversationId)
}

export function resolveEditUltracode(chat: ChatState, conversationId: unknown, messageId: unknown): boolean {
  const editingTarget = chat.composition.editingBranch && String(chat.composition.branchEditMessageId) === String(messageId) &&
    String(chat.conversation.currentConversationId) === String(conversationId)
  return (editingTarget ? chat.composition.branchEditModes?.claudeUltracode : undefined)
    ?? resolveAnchoredUltracode(chat, conversationId, messageId)
}

const STORAGE_KEY = 'chat:claudeUltracodeDrafts'
export function loadClaudeUltracodeDrafts(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  } catch { return {} }
}

export function saveClaudeUltracodeDrafts(drafts: Record<string, boolean>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts)) }
  catch (error) { console.warn('Unable to save branch Ultracode selections', error) }
}
