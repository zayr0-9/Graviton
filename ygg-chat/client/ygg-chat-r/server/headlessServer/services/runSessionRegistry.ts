/**
 * RunSessionRegistry — decouples a chat run's LIFETIME from its SSE connection.
 *
 * Gated behind `gateway.resumableRuns` (default ON; explicit false opts out). When ON, the chat route routes
 * the orchestrator's `emit` through a per-streamId RunSession instead of writing
 * straight to one `res`. The session:
 *   - owns the run's AbortController (so ONLY an explicit cancel — POST
 *     /api/streams/:id/abort — stops the run; a bare client disconnect
 *     just DETACHES),
 *   - buffers every emitted event with a monotonic `seq` so a reconnecting client can
 *     replay from a cursor,
 *   - fans out to independent attached subscribers; losing viewers never cancels execution.
 *
 * Everything here is in-memory: when the Electron main process exits, every session
 * dies with it (the accepted ceiling — app-quit kills background runs).
 *
 * No Express coupling: the route adapts its `res` to the small RunSubscriber sink.
 */

import { SnapshotPayloadStore } from './snapshotPayloadStore.js'
import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors.js'
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'

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
  readonly snapshotPayloads = new SnapshotPayloadStore()
  dispose(): void { this.detach(); this.snapshotPayloads.dispose() }
  readonly conversationId: string | null
  private readonly aborter = new AbortController()
  private readonly bufferCap: number

  readonly createdAt = new Date().toISOString()
  lineageId: string | null = null
  parentId: string | null = null
  effectiveConfiguration?: { provider: string; modelName: string; fullAccess: boolean; toolAutoApprove: boolean; operationMode: 'plan' | 'execute' }
  status: RunStatus = 'running'
  /** Wall-clock (ms) the run reached a terminal status; null while running. */
  terminalAt: number | null = null
  /** Wall-clock (ms) the last subscriber detached while still running; null when attached. */
  detachedAt: number | null = null

  private buffer: BufferedEvent[] = []
  private seqCounter = 0
  /** seq of the oldest event still retained (0 = nothing dropped yet). */
  private droppedThroughSeq = 0
  private readonly subscribers = new Set<RunSubscriber>()
  private terminalPublished = false
  private cancellationFallbackFired = false
  private lateFrameWarned = false
  private bufferBytes = 0
  private readonly maxBufferBytes = 16 * 1024 * 1024
  private snapshotProvider?: () => import('../../../../../shared/runProtocol.js').MainRunBootstrap
  private childSnapshotProvider?: () => import('../../../../../shared/runProtocol.js').ChildRunBootstrap
  setChildSnapshotProvider(provider: () => import('../../../../../shared/runProtocol.js').ChildRunBootstrap): void { this.childSnapshotProvider = provider }
  private project?: (event: HeadlessStreamEvent) => void
  private projectionFailed = false
  private onEvent?: (event: HeadlessStreamEvent) => void
  setEventObserver(observer: (event: HeadlessStreamEvent) => void): void { this.onEvent = observer }

  setProjector(project: (event: HeadlessStreamEvent) => void): void { this.project = project }

  get kind(): 'main' | 'child' { return this.snapshotProvider ? 'main' : 'child' }

  setSnapshotProvider(provider: () => import('../../../../../shared/runProtocol.js').MainRunBootstrap): void {
    this.snapshotProvider = provider
  }

  attachSnapshot(subscriber: RunSubscriber): AttachResult {
    if (this.projectionFailed) throw new Error('Run snapshot projection unavailable')
    if (!this.snapshotProvider && !this.childSnapshotProvider) return this.attach(subscriber, 0)
    // JS run-to-completion plus synchronous SQLite reads form one boundary S.
    const snapshot = this.snapshotProvider ? this.snapshotProvider() : this.childSnapshotProvider!()
    const terminal = this.terminalPublished
    if (!terminal) this.subscribers.add(subscriber)
    try {
      const envelope: HeadlessStreamEvent = snapshot.kind === 'main' ? { type: 'bootstrap', snapshot } : { type: 'child_bootstrap', snapshot }
      const event: HeadlessStreamEvent = Buffer.byteLength(JSON.stringify(envelope)) > 256 * 1024
        ? { type: 'snapshot_reference', streamId: this.streamId, reference: this.snapshotPayloads.capture(envelope) } : envelope
      subscriber.send({ seq: snapshot.stateSeq, event })
    }
    catch (error) { this.detach(subscriber); throw error }
    if (terminal) { subscriber.end(); return { status: 'replayed-terminal', finalStatus: this.status } }
    this.detachedAt = null
    return { status: 'attached-live' }
  }

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
    return this.subscribers.size > 0
  }

  /**
   * Ingest one event from the loop. Assigns a seq, buffers it (dropping the oldest
   * past the cap), updates terminal status, and fans out to the attached subscriber.
   * On a terminal event the live subscriber is flushed and released.
   */
  publish(event: HeadlessStreamEvent): void {
    if (this.terminalPublished) {
      if (this.cancellationFallbackFired && !this.lateFrameWarned) {
        this.lateFrameWarned = true
        console.warn('[RunSession] Late event after cancellation fallback; reload persisted conversation state.', { streamId: this.streamId, type: event.type })
      }
      return
    }
    if (event.type === 'started') {
      this.lineageId = event.lineageId ?? null
      this.parentId = event.parentId
    }
    try { this.onEvent?.(event) } catch {
      console.warn('[RunSession] Could not record command outcome', { streamId: this.streamId, type: event.type })
    }
    if (!this.projectionFailed) {
      try { this.project?.(event) } catch {
        this.projectionFailed = true
        console.warn('[RunSession] Snapshot projection unavailable; execution continues.', { streamId: this.streamId, type: event.type })
      }
    }
    const seq = ++this.seqCounter
    // A large single tool/image/persisted-row frame must not bypass the viewer
    // byte queue merely because it was the first write. Lease it on demand too.
    let transportEvent = event
    if (Buffer.byteLength(JSON.stringify(event)) > 256 * 1024) {
      try { transportEvent = { type: 'event_reference', streamId: this.streamId, reference: this.snapshotPayloads.capture(event, false) } }
      catch {
        // Fail this viewer payload explicitly, not the run. Do not ship an
        // unbounded frame after scratch capacity is exhausted.
        transportEvent = { type: 'observer_resync_required', streamId: this.streamId }
      }
    }
    const frame: BufferedEvent = { seq, event: transportEvent }
    this.buffer.push(frame)
    this.bufferBytes += Buffer.byteLength(JSON.stringify(frame))
    while (this.buffer.length > this.bufferCap || this.bufferBytes > this.maxBufferBytes) {
      const dropped = this.buffer.shift()
      if (!dropped) break
      this.droppedThroughSeq = dropped.seq
      this.bufferBytes -= Buffer.byteLength(JSON.stringify(dropped))
    }

    const terminal = event.type === 'complete' || (event.type === 'error' && event.terminal !== false)
    if (terminal) {
      // A cancel() already set status='cancelled'; keep that classification even though
      // the abort surfaces as a terminal 'error' frame from the route's catch.
      this.terminalPublished = true
      if (event.type === 'complete' && this.status !== 'cancelled') this.status = 'completed'
      else if (this.status !== 'cancelled') this.status = 'errored'
      this.terminalAt = Date.now()
    }

    for (const subscriber of [...this.subscribers]) {
      try { subscriber.send(frame) } catch { this.detach(subscriber) }
      if (terminal) {
        try { subscriber.end() } catch { /* A failed viewer cannot interrupt execution. */ }
        this.subscribers.delete(subscriber)
      }
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
    if (!Number.isSafeInteger(fromSeq) || fromSeq < this.droppedThroughSeq || fromSeq > this.seqCounter) {
      return { status: 'truncated' }
    }

    for (const frame of this.buffer) {
      if (frame.seq > fromSeq) subscriber.send(frame)
    }

    if (this.isTerminal()) {
      subscriber.end()
      return { status: 'replayed-terminal', finalStatus: this.status }
    }

    this.subscribers.add(subscriber)
    this.detachedAt = null
    return { status: 'attached-live' }
  }

  /**
   * Release only the given viewer, without stopping execution. With no argument,
   * close all transports (registry replacement/deletion).
   */
  detach(subscriber?: RunSubscriber): void {
    if (subscriber) this.subscribers.delete(subscriber)
    else {
      for (const current of this.subscribers) {
        try { current.end() } catch { /* transport already closed */ }
      }
      this.subscribers.clear()
    }
    if (!this.subscribers.size && this.status === 'running' && this.detachedAt === null) {
      this.detachedAt = Date.now()
    }
  }

  /** Explicitly cancel the run (POST /abort or reaper). Aborts the loop's signal. */
  cancel(): void {
    if (this.status !== 'running') return
    this.status = 'cancelled'
    this.aborter.abort()
    // Let the engine persist/project partial output on unwind. A broken executor
    // still cannot keep observer sockets open forever after an accepted Stop.
    const timeout = setTimeout(() => {
      if (!this.terminalPublished) {
        this.cancellationFallbackFired = true
        this.publish({ type: 'error', error: 'Run cancelled', terminal: true,
          envelope: buildChatErrorEnvelope('cancelled') })
      }
    }, 5000)
    timeout.unref?.()
  }
}

export interface ReapPolicy {
  /** Evict a terminal run this long after it finished (ms), so a late reconnect can drain the tail. */
  terminalLingerMs: number
}

const DEFAULT_REAP: ReapPolicy = {
  terminalLingerMs: 60_000,
}

export class RunSessionRegistry {
  private readonly sessions = new Map<string, RunSession>()
  private readonly policy: ReapPolicy
  private readonly bufferCap: number
  private configureMain?: (session: RunSession) => void
  disposeAll(): void {
    for (const session of this.sessions.values()) { session.cancel(); session.dispose() }
    this.sessions.clear()
  }

  setMainSessionFactory(configure: (session: RunSession) => void): void { this.configureMain = configure }

  createMain(streamId: string, conversationId: string): RunSession {
    const existing = this.get(streamId)
    if (existing) return existing
    const session = this.create(streamId, conversationId)
    this.configureMain?.(session)
    return session
  }

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

  list(conversationId?: string): RunSession[] {
    return [...this.sessions.values()].filter(session => !conversationId || session.conversationId === conversationId)
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

  /**
   * Replace a stream owner safely. A duplicate POST must not detach and orphan the old
   * run: abort it first so every decision/tool wait unwinds, then install the new owner.
   */
  replace(streamId: string, conversationId: string | null): RunSession {
    const existing = this.sessions.get(streamId)
    if (existing) {
      existing.cancel()
      existing.dispose()
      this.sessions.delete(streamId)
    }
    return this.create(streamId, conversationId)
  }

  /** Drop a session from the registry (does not cancel; terminal eviction only). */
  delete(streamId: string): void {
    const session = this.sessions.get(streamId)
    if (!session) return
    session.dispose()
    this.sessions.delete(streamId)
  }

  size(): number {
    return this.sessions.size
  }

  /**
   * Evict terminal payloads after their linger window. Running sessions are never
   * cancelled based on subscriber count; execution limits belong to the engine.
   */
  reap(now: number = Date.now()): string[] {
    const evicted: string[] = []
    for (const [streamId, session] of this.sessions) {
      if (session.isTerminal()) {
        if (session.terminalAt !== null && now - session.terminalAt >= this.policy.terminalLingerMs) {
          session.dispose()
          this.sessions.delete(streamId)
          evicted.push(streamId)
        }
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
