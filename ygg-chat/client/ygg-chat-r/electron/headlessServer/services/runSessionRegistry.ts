/**
 * RunSessionRegistry — decouples a chat run's LIFETIME from its SSE connection.
 *
 * Gated behind `gateway.resumableRuns` (default ON; explicit false opts out). When ON, the chat route routes
 * the orchestrator's `emit` through a per-streamId RunSession instead of writing
 * straight to one `res`. The session:
 *   - owns the run's AbortController (so ONLY an explicit cancel — POST
 *     /api/streams/:id/abort — or the reaper stops the run; a bare client disconnect
 *     just DETACHES),
 *   - buffers every emitted event with a monotonic `seq` so a reconnecting client can
 *     replay from a cursor,
 *   - fans out to at most one attached subscriber (last attach wins).
 *
 * Everything here is in-memory: when the Electron main process exits, every session
 * dies with it (the accepted ceiling — app-quit kills background runs).
 *
 * No Express coupling: the route adapts its `res` to the small RunSubscriber sink.
 */

import type { HeadlessStreamEvent } from '../contracts/headlessApi.js'

export type RunStatus = 'running' | 'completed' | 'errored' | 'cancelled'

/** One buffered, sequence-stamped event. `seq` is 1-based and strictly increasing. */
export interface BufferedEvent {
  seq: number
  event: HeadlessStreamEvent
}

/**
 * The transport a session writes to. The route wraps an Express `res`; tests pass a
 * simple recorder. `send` must tolerate an already-closed transport (no throw).
 */
export interface RunSubscriber {
  send: (frame: BufferedEvent) => void
  end: () => void
}

export type AttachResult =
  | { status: 'attached-live' }
  | { status: 'replayed-terminal'; finalStatus: RunStatus }
  /** The client's cursor is older than the retained buffer; it must full-reload. */
  | { status: 'truncated' }

const DEFAULT_BUFFER_CAP = 20_000

export class RunSession {
  readonly streamId: string
  readonly conversationId: string | null
  private readonly aborter = new AbortController()
  private readonly bufferCap: number

  status: RunStatus = 'running'
  /** Wall-clock (ms) the run reached a terminal status; null while running. */
  terminalAt: number | null = null
  /** Wall-clock (ms) the last subscriber detached while still running; null when attached. */
  detachedAt: number | null = null

  private buffer: BufferedEvent[] = []
  private seqCounter = 0
  /** seq of the oldest event still retained (0 = nothing dropped yet). */
  private droppedThroughSeq = 0
  private subscriber: RunSubscriber | null = null

  constructor(streamId: string, conversationId: string | null, bufferCap: number = DEFAULT_BUFFER_CAP) {
    this.streamId = streamId
    this.conversationId = conversationId
    this.bufferCap = Math.max(1, bufferCap)
  }

  /** The abort signal handed to orchestrator.runMessage. Fires only on cancel()/reap. */
  get signal(): AbortSignal {
    return this.aborter.signal
  }

  get latestSeq(): number {
    return this.seqCounter
  }

  isTerminal(): boolean {
    return this.status !== 'running'
  }

  hasSubscriber(): boolean {
    return this.subscriber !== null
  }

  /**
   * Ingest one event from the loop. Assigns a seq, buffers it (dropping the oldest
   * past the cap), updates terminal status, and fans out to the attached subscriber.
   * On a terminal event the live subscriber is flushed and released.
   */
  publish(event: HeadlessStreamEvent): void {
    const seq = ++this.seqCounter
    const frame: BufferedEvent = { seq, event }
    this.buffer.push(frame)
    if (this.buffer.length > this.bufferCap) {
      const dropped = this.buffer.shift()
      if (dropped) this.droppedThroughSeq = dropped.seq
    }

    const terminal = event.type === 'complete' || event.type === 'error'
    if (terminal) {
      // A cancel() already set status='cancelled'; keep that classification even though
      // the abort surfaces as a terminal 'error' frame from the route's catch.
      if (event.type === 'complete') this.status = 'completed'
      else if (this.status !== 'cancelled') this.status = 'errored'
      this.terminalAt = Date.now()
    }

    this.subscriber?.send(frame)

    if (terminal && this.subscriber) {
      this.subscriber.end()
      this.subscriber = null
    }
  }

  /**
   * Attach a subscriber and replay every buffered frame after `fromSeq`.
   * - If the run already ended, the tail is replayed and the subscriber is closed
   *   (`replayed-terminal`) — a late reconnect still sees the final `complete`/`error`.
   * - If `fromSeq` predates the retained buffer, replay is impossible (`truncated`) and
   *   the caller should tell the client to reload persisted messages.
   * - Otherwise the subscriber becomes live and receives future frames.
   */
  attach(subscriber: RunSubscriber, fromSeq = 0): AttachResult {
    if (fromSeq > 0 && fromSeq < this.droppedThroughSeq) {
      return { status: 'truncated' }
    }

    for (const frame of this.buffer) {
      if (frame.seq > fromSeq) subscriber.send(frame)
    }

    if (this.isTerminal()) {
      subscriber.end()
      return { status: 'replayed-terminal', finalStatus: this.status }
    }

    // Live attach: last writer wins — release any prior subscriber first.
    if (this.subscriber && this.subscriber !== subscriber) {
      this.subscriber.end()
    }
    this.subscriber = subscriber
    this.detachedAt = null
    return { status: 'attached-live' }
  }

  /**
   * Release the current subscriber WITHOUT stopping the run (a bare client disconnect).
   * No-op if `subscriber` is provided and is not the current one (a newer attach won).
   */
  detach(subscriber?: RunSubscriber): void {
    if (subscriber && subscriber !== this.subscriber) return
    this.subscriber = null
    if (this.status === 'running' && this.detachedAt === null) {
      this.detachedAt = Date.now()
    }
  }

  /** Explicitly cancel the run (POST /abort or reaper). Aborts the loop's signal. */
  cancel(): void {
    if (this.status === 'running') this.status = 'cancelled'
    this.aborter.abort()
  }
}

export interface ReapPolicy {
  /** Cancel + evict a still-running run detached (no subscriber) at least this long (ms). */
  idleDetachedMs: number
  /** Evict a terminal run this long after it finished (ms), so a late reconnect can drain the tail. */
  terminalLingerMs: number
}

const DEFAULT_REAP: ReapPolicy = {
  idleDetachedMs: 5 * 60_000,
  terminalLingerMs: 60_000,
}

export class RunSessionRegistry {
  private readonly sessions = new Map<string, RunSession>()
  private readonly policy: ReapPolicy
  private readonly bufferCap: number

  constructor(opts: { policy?: Partial<ReapPolicy>; bufferCap?: number } = {}) {
    this.policy = { ...DEFAULT_REAP, ...(opts.policy ?? {}) }
    this.bufferCap = opts.bufferCap ?? DEFAULT_BUFFER_CAP
  }

  /** Create the session for a streamId, or return the existing one (idempotent). */
  create(streamId: string, conversationId: string | null): RunSession {
    const existing = this.sessions.get(streamId)
    if (existing) return existing
    const session = new RunSession(streamId, conversationId, this.bufferCap)
    this.sessions.set(streamId, session)
    return session
  }

  get(streamId: string): RunSession | undefined {
    return this.sessions.get(streamId)
  }

  /** Explicit cancel by id. Returns false if no live session exists. */
  cancel(streamId: string): boolean {
    const session = this.sessions.get(streamId)
    if (!session) return false
    session.cancel()
    return true
  }

  /** Drop a session from the registry (does not cancel; caller decides). */
  delete(streamId: string): void {
    const session = this.sessions.get(streamId)
    if (!session) return
    session.detach()
    this.sessions.delete(streamId)
  }

  size(): number {
    return this.sessions.size
  }

  /**
   * One reaper sweep. Evicts terminal sessions past their linger window and cancels +
   * evicts still-running sessions abandoned (detached) past the idle bound. Returns the
   * evicted stream ids (useful for tests/telemetry).
   */
  reap(now: number = Date.now()): string[] {
    const evicted: string[] = []
    for (const [streamId, session] of this.sessions) {
      if (session.isTerminal()) {
        if (session.terminalAt !== null && now - session.terminalAt >= this.policy.terminalLingerMs) {
          this.sessions.delete(streamId)
          evicted.push(streamId)
        }
      } else if (session.detachedAt !== null && now - session.detachedAt >= this.policy.idleDetachedMs) {
        session.cancel()
        session.detach()
        this.sessions.delete(streamId)
        evicted.push(streamId)
      }
    }
    return evicted
  }

  /** Start the periodic reaper. Returns a stop function. The timer is unref'd. */
  startReaper(intervalMs = 30_000): () => void {
    const timer = setInterval(() => this.reap(), Math.max(1_000, intervalMs))
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    return () => clearInterval(timer)
  }
}
