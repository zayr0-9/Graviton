import { createHash } from 'node:crypto'
import type { MessageQueueSnapshot, QueuedMessageSubmission, QueuedMessageView } from '../../../../../shared/queuedMessages.js'

interface Entry {
  fingerprint: string
  submission: QueuedMessageSubmission
  modeRevision: number
  view: QueuedMessageView
}

/** In-process run mailbox. Intake/claim/close are synchronous so completion cannot lose a send. */
export class MessageInputQueue {
  private entries = new Map<string, Entry>()
  private revision = 0
  private payloadBytes = 0
  closed = false
  constructor(
    readonly streamId: string,
    readonly conversationId: string,
    public lineageId: string | null,
    private publish: (snapshot: MessageQueueSnapshot) => void,
  ) {}

  snapshot(): MessageQueueSnapshot {
    return { streamId: this.streamId, conversationId: this.conversationId, lineageId: this.lineageId,
      revision: this.revision, items: [...this.entries.values()].map(entry => ({ ...entry.view })) }
  }
  private changed() { this.revision++; this.publish(this.snapshot()) }
  get hasPending() { return [...this.entries.values()].some(entry => entry.view.status === 'queued') }
  get(requestId: string) { return this.entries.get(requestId) }

  enqueue(submission: QueuedMessageSubmission, modeRevision: number): QueuedMessageView {
    const fingerprint = createHash('sha256').update(JSON.stringify(submission)).digest('hex')
    const existing = this.entries.get(submission.requestId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Submission id already used for another message')
      return existing.view
    }
    if (this.closed) throw new Error('Run no longer accepts queued messages')
    if (this.entries.size >= 100) throw new Error('This run has reached its queued-message limit')
    const bytes = JSON.stringify(submission).length
    if (this.payloadBytes + bytes > 24 * 1024 * 1024) throw new Error('Queued messages exceed the per-run size limit')
    this.payloadBytes += bytes
    const view: QueuedMessageView = { requestId: submission.requestId, content: submission.content,
      attachmentCount: submission.attachmentsBase64?.length ?? 0, status: 'queued' }
    this.entries.set(submission.requestId, { submission, modeRevision, view, fingerprint })
    this.changed()
    return view
  }
  claim(): Entry | undefined {
    const entry = [...this.entries.values()].find(entry => entry.view.status === 'queued')
    if (entry) { entry.view.status = 'delivering'; this.changed() }
    return entry
  }
  settle(requestId: string, result: { messageId: string } | { error: string }) {
    const entry = this.entries.get(requestId)
    if (!entry) return
    entry.view = 'messageId' in result
      ? { ...entry.view, status: 'delivered', messageId: result.messageId }
      : { ...entry.view, status: 'failed', error: result.error }
    // Keep ids/content for dedup/recovery, release potentially large image payloads.
    entry.submission = { ...entry.submission, attachmentsBase64: undefined }
    this.changed()
  }
  cancel(requestId: string): boolean {
    const entry = this.entries.get(requestId)
    if (!entry) return false
    if (entry.view.status === 'cancelled') return true
    if (entry.view.status !== 'queued' && entry.view.status !== 'failed') return false
    entry.view.status = 'cancelled'
    entry.submission = { ...entry.submission, attachmentsBase64: undefined }
    this.changed()
    return true
  }
  /** Called immediately before natural completion; false means the loop must continue. */
  tryClose(): boolean {
    if (this.hasPending) return false
    this.closed = true
    return true
  }
  failRemaining(reason: string) {
    this.closed = true
    for (const entry of this.entries.values()) {
      if (entry.view.status === 'queued' || entry.view.status === 'delivering') {
        entry.view = { ...entry.view, status: 'failed', error: reason }
      }
      entry.submission = { ...entry.submission, attachmentsBase64: undefined }
    }
    this.changed()
  }
}
