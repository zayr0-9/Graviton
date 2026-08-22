/**
 * DecisionBroker — the server-side pause/resume registry for the stateful
 * thin-client chat loop.
 *
 * Phase 0 foundation. Fully implemented and unit-tested here, but not yet wired
 * into the tool loop (that happens in Phase 2, inside the per-run wrapping
 * executor built by ChatOrchestrator). Nothing imports it yet, so it is inert.
 *
 * Design (see the refactor plan, "Crux — concrete integration points"):
 * - The paused executor calls `requestDecision({ streamId, toolCallId, signal })`
 *   and awaits the returned promise while the loop is suspended at the tool
 *   choke point. The caller is responsible for emitting the matching SSE event
 *   (permission_required / clarify_required / tool_request) before awaiting.
 * - `POST /resume` (Phase 2) looks the pending entry up by (streamId, toolCallId)
 *   and calls `resolve(...)`, unblocking the loop.
 * - The run's AbortSignal (from res.on('close')) rejects the pending promise so a
 *   disconnected client never hangs the loop.
 * - Per-stream sessions carry the "allow always / auto-approve" decision so the
 *   loop can skip future pauses within the same run.
 */

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'
export type OperationModeUpgradeDecision = 'switch_to_execute' | 'deny'

export interface ClarifyDecision {
  cancelled?: boolean
  answers?: any[]
}

export interface ToolBridgeDecision {
  result?: any
  error?: string
}

export type Decision = PermissionDecision | OperationModeUpgradeDecision | ClarifyDecision | ToolBridgeDecision
export type DecisionKind = 'permission' | 'operation_mode_upgrade' | 'clarify' | 'tool_bridge' | 'any'

function decisionMatchesKind(kind: DecisionKind, decision: Decision): boolean {
  if (kind === 'any') return true
  if (kind === 'permission') return decision === 'allow_once' || decision === 'allow_always' || decision === 'deny'
  if (kind === 'operation_mode_upgrade') return decision === 'switch_to_execute' || decision === 'deny'
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return false
  if (kind === 'clarify') return 'answers' in decision || 'cancelled' in decision
  return 'result' in decision || 'error' in decision
}

export class DecisionAbortedError extends Error {
  constructor(message = 'Decision aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

interface PendingEntry {
  kind: DecisionKind
  resolve: (decision: Decision) => void
  reject: (error: Error) => void
  cleanup: () => void
}

interface StreamSession {
  autoApproveAll: boolean
}

/** Composite key: one pending decision per (stream, toolCall). */
function keyFor(streamId: string, toolCallId: string): string {
  return `${streamId}::${toolCallId}`
}

export class DecisionBroker {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly sessions = new Map<string, StreamSession>()

  /**
   * Suspend on a decision from the client. Rejects with an AbortError if the
   * provided signal aborts (client disconnect). The caller emits the SSE event.
   */
  requestDecision<T extends Decision = Decision>(opts: {
    streamId: string
    toolCallId: string
    kind?: DecisionKind
    signal?: AbortSignal
  }): Promise<T> {
    const { streamId, toolCallId, kind = 'any', signal } = opts
    const key = keyFor(streamId, toolCallId)

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DecisionAbortedError())
        return
      }

      // Allow-all is a stream policy, not merely one tool-call answer. A parallel
      // nested call may have observed the old policy immediately before another call
      // enabled it; do not let that stale check create a new parked permission waiter.
      if (kind === 'permission' && this.isAutoApproveAll(streamId)) {
        resolve('allow_always' as T)
        return
      }

      // If a stale entry exists for this key, reject it before replacing.
      const existing = this.pending.get(key)
      if (existing) {
        existing.cleanup()
        existing.reject(new Error(`Superseded pending decision: ${key}`))
        this.pending.delete(key)
      }

      const onAbort = () => {
        const entry = this.pending.get(key)
        if (entry) {
          this.pending.delete(key)
          entry.cleanup()
          entry.reject(new DecisionAbortedError())
        }
      }

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort)
      }

      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      this.pending.set(key, {
        kind,
        resolve: decision => resolve(decision as T),
        reject,
        cleanup,
      })
    })
  }

  /** Resolve a pending decision (called by POST /resume). Returns false on no match or wrong decision kind. */
  resolve(streamId: string, toolCallId: string, decision: Decision): boolean {
    const key = keyFor(streamId, toolCallId)
    const entry = this.pending.get(key)
    if (!entry || !decisionMatchesKind(entry.kind, decision)) return false

    if (entry.kind === 'permission' && decision === 'allow_always') {
      // Several parallel multi_call workers can already be parked by the time the user
      // answers the one prompt the renderer can display. Atomically promote the stream
      // and release every existing permission waiter. Clarification and operation-mode
      // decisions remain interactive and are deliberately untouched.
      this.setAutoApproveAll(streamId)
      const prefix = `${streamId}::`
      for (const [pendingKey, pendingEntry] of this.pending) {
        if (!pendingKey.startsWith(prefix) || pendingEntry.kind !== 'permission') continue
        this.pending.delete(pendingKey)
        pendingEntry.cleanup()
        pendingEntry.resolve('allow_always')
      }
      return true
    }

    this.pending.delete(key)
    entry.cleanup()
    entry.resolve(decision)
    return true
  }

  /** Reject a pending decision. Returns false if none matched. */
  reject(streamId: string, toolCallId: string, error: Error): boolean {
    const key = keyFor(streamId, toolCallId)
    const entry = this.pending.get(key)
    if (!entry) return false
    this.pending.delete(key)
    entry.cleanup()
    entry.reject(error)
    return true
  }

  /** Drain every pending decision for a stream (called in the run's finally). */
  rejectAllForStream(streamId: string, error: Error = new DecisionAbortedError()): void {
    const prefix = `${streamId}::`
    for (const [key, entry] of this.pending) {
      if (key.startsWith(prefix)) {
        this.pending.delete(key)
        entry.cleanup()
        entry.reject(error)
      }
    }
    this.sessions.delete(streamId)
  }

  hasPending(streamId: string, toolCallId: string): boolean {
    return this.pending.has(keyFor(streamId, toolCallId))
  }

  // ── Per-stream sessions (auto-approve / allow-always) ──

  initSession(streamId: string, opts?: { autoApproveAll?: boolean }): void {
    this.sessions.set(streamId, { autoApproveAll: opts?.autoApproveAll ?? false })
  }

  isAutoApproveAll(streamId: string): boolean {
    return this.sessions.get(streamId)?.autoApproveAll ?? false
  }

  setAutoApproveAll(streamId: string): void {
    const session = this.sessions.get(streamId)
    if (session) session.autoApproveAll = true
    else this.sessions.set(streamId, { autoApproveAll: true })
  }

  clearSession(streamId: string): void {
    this.sessions.delete(streamId)
  }
}
