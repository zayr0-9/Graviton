import type { ChatState, StreamState } from './chatTypes'
import { isStreamContinuationTail } from './streamContinuationTail'

/** Passive observers extend only the selected tip; they never claim view ownership. */
export function canFollowSelectedTip(state: ChatState, stream: StreamState, targetMessageId?: string,
  recovery?: { allowDescendants: boolean; allowEmpty: boolean }): boolean {
  if (!stream.followSelectedTip || state.selection.status === 'pending' || state.selection.status === 'error' ||
      String(stream.conversationId) !== String(state.conversation.currentConversationId)) return false
  if (state.conversation.currentLineageId && stream.lineage.lineageIdConfirmed &&
      state.conversation.currentLineageId !== stream.lineage.lineageId) return false
  const path = state.conversation.currentPath
  const tip = path.at(-1)
  if ((!tip && !recovery?.allowEmpty) || !targetMessageId) return false
  const byId = new Map(state.conversation.messages.map(message => [String(message.id), message]))
  const target = byId.get(String(targetMessageId))
  if (!target) return false
  // Validate the whole path before the reducer's root-to-message walk.
  const seen = new Set<string>()
  let id: string | null = String(targetMessageId)
  while (id != null && !seen.has(id)) {
    seen.add(id)
    const row = byId.get(id)
    if (!row || String(row.conversation_id) !== String(stream.conversationId)) return false
    id = row.parent_id == null ? null : String(row.parent_id)
  }
  if (id != null) return false
  if (recovery?.allowDescendants) return tip == null || seen.has(String(tip))
  if (String(tip) === String(targetMessageId) || String(tip) === String(target.parent_id)) return true
  // A replay/upsert must not cut off an already selected control/context tail.
  const at = path.findIndex(value => String(value) === String(targetMessageId))
  return at >= 0 && path.slice(at + 1).every(value => isStreamContinuationTail(byId.get(String(value))))
}
