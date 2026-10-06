import type { WatchCompletionEvent } from '../../../../../shared/watchEvents'
import { addInflightStream, listInflightStreams } from './inflightStreams'

/** Adopt server-owned continuation without replacing an existing reader/cursor
 * or changing the user's selected branch/composer.
 */
export function adoptWatchContinuation(event: WatchCompletionEvent, hasReader: (id: string) => boolean): string | null {
  if (!event.streamId || !['queued', 'restarted'].includes(event.delivery ?? '') || hasReader(event.streamId)) return null
  if (!listInflightStreams(event.conversationId).some(record => record.streamId === event.streamId)) {
    addInflightStream({ streamId: event.streamId, conversationId: event.conversationId,
      streamType: 'branch', parentMessageId: event.parentId ?? event.messageId, updatePath: false })
  }
  return event.streamId
}
