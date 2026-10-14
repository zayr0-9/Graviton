import type { WatchCompletionEvent } from '../../../../../shared/watchEvents'
import { addInflightStream, listInflightStreams } from './inflightStreams'
import type { ChatState, StreamState } from './chatTypes'

/** Adopt server-owned continuation without replacing an existing reader/cursor
 * or changing the user's selected branch/composer.
 */
export function adoptWatchContinuation(event: WatchCompletionEvent, hasReader: (id: string) => boolean): string | null {
  if (!event.streamId || !['queued', 'restarted'].includes(event.delivery ?? '') || hasReader(event.streamId)) return null
  if (!listInflightStreams(event.conversationId).some(record => record.streamId === event.streamId)) {
    addInflightStream({ streamId: event.streamId, conversationId: event.conversationId,
      streamType: 'branch', parentMessageId: event.parentId ?? event.messageId, updatePath: true,
      watchContinuation: { lineageId: event.lineageId, parentMessageId: event.parentId ?? null } })
  }
  return event.streamId
}

/** Re-evaluated for each projected mutation, not just when the watch fires. A shared
 * ancestor or even matching lineage alone must not pull a historical/sibling tip
 * into this run. Require the selected tip on the actual continuation chain, at or
 * after its parent. Missing rows and cycles fail closed.
 */
export function canFollowWatchContinuation(state: ChatState, stream: StreamState, targetMessageId?: string): boolean {
  const owner = stream.watchContinuation
  if (!owner || state.selection.status === 'pending' || state.selection.status === 'error' ||
      String(stream.conversationId) !== String(state.conversation.currentConversationId)) return false
  const lineageId = stream.lineage.lineageIdConfirmed ? stream.lineage.lineageId : owner.lineageId
  if (state.conversation.currentLineageId != null && state.conversation.currentLineageId !== lineageId) return false

  const tip = state.conversation.currentPath.at(-1)
  // Legacy/queued notifications may lack the actual parent. The registration
  // message is not a safe substitute: it can be far back in shared history.
  const parent = owner.parentMessageId
  if (tip == null || parent == null) return false
  const byId = new Map(state.conversation.messages.map(message => [String(message.id), message]))
  const candidates = targetMessageId != null ? [targetMessageId] : [
    stream.currentBranchAnchorMessageId, stream.lastCompletedMessageId,
    stream.triggerUserMessageId, stream.lineage.rootMessageId,
  ]
  return candidates.some(candidate => {
    const seen = new Set<string>()
    let id = candidate == null ? null : String(candidate)
    let includesTip = false
    let reachedParent = false
    while (id != null && !seen.has(id)) {
      seen.add(id)
      const row = byId.get(id)
      if (!row || String(row.conversation_id) !== String(stream.conversationId)) return false
      if (!reachedParent && id === String(tip)) includesTip = true
      if (id === String(parent)) reachedParent = true
      id = row.parent_id == null ? null : String(row.parent_id)
    }
    // Validate through the root as the subsequent path builder walks that far too.
    return id == null && reachedParent && includesTip
  })
}
