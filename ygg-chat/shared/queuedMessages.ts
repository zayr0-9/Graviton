import type { HeadlessMessageRequest } from './headlessApi.js'

export interface QueuedMessageSubmission {
  requestId: string
  content: string
  watcherCompletion?: { handle: string; originMessageId: string }
  attachmentsBase64?: HeadlessMessageRequest['attachmentsBase64']
}

export interface QueuedMessageView {
  requestId: string
  content: string
  attachmentCount: number
  status: 'queued' | 'delivering' | 'delivered' | 'cancelled' | 'failed'
  messageId?: string
  error?: string
}

export interface MessageQueueSnapshot {
  streamId: string
  conversationId: string
  lineageId: string | null
  revision: number
  items: QueuedMessageView[]
}
