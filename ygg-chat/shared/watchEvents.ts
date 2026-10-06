export type WatchState = 'waiting' | 'triggered' | 'timed_out' | 'cancelled' | 'error'

/** Only routing IDs and fixed metadata cross the notification channel. */
export interface WatchCompletionEvent {
  handle: string
  state: Exclude<WatchState, 'waiting' | 'cancelled'>
  kind: 'process_exit' | 'file_created' | 'file_changed' | 'log_match' | 'http_status'
  conversationId: string
  lineageId: string
  messageId: string
  projectId: string | null
  completedAt: string
  /** Delivery acceptance; queued does not imply persistence yet. */
  delivery?: 'queued' | 'restarted' | 'failed'
  streamId?: string
  parentId?: string | null
}
