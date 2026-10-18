export interface ClaudeBridgeSource {
  action: 'start' | 'send' | 'resume' | 'fork'
  toolCallId: string
  messageId?: string
  streamId?: string
}

export interface WatcherCompletionProvenance {
  handle: string
  originMessageId: string
  /** Original job launch, distinct from the wait registration. */
  source?: ClaudeBridgeSource
  registrationToolCallId?: string
}

export type WatchState = 'waiting' | 'triggered' | 'timed_out' | 'cancelled' | 'error'

/** Only routing IDs and fixed metadata cross the notification channel. */
export interface WatchCompletionEvent {
  handle: string
  state: Exclude<WatchState, 'waiting' | 'cancelled'>
  kind: 'process_exit' | 'file_created' | 'file_changed' | 'log_match' | 'http_status' | 'claude_bridge'
  conversationId: string
  lineageId: string
  messageId: string
  projectId: string | null
  completedAt: string
  source?: ClaudeBridgeSource
  registrationToolCallId?: string
  /** Delivery acceptance; queued does not imply persistence yet. */
  delivery?: 'queued' | 'restarted' | 'failed'
  streamId?: string
  parentId?: string | null
}
