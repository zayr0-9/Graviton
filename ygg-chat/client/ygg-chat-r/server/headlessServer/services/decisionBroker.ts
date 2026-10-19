/**
 * DecisionBroker — the server-side pause/resume registry for the stateful
 * thin-client chat loop.
 *
 * Shared by the running engine and every observer. Register before publishing;
 * settlement broadcasts contain correlation metadata, never private answers.
 *
 * Design (see the refactor plan, "Crux — concrete integration points"):
 * - The paused executor calls `requestDecision({ streamId, toolCallId, signal })`
 *   and awaits the returned promise while the loop is suspended at the tool
 *   choke point. The caller is responsible for emitting the matching SSE event
 *   (permission_required / clarify_required / tool_request) before awaiting.
 * - `POST /resume` (Phase 2) looks the pending entry up by (streamId, toolCallId)
 *   and calls `resolve(...)`, unblocking the loop.
 * - The run-owned AbortSignal rejects pending promises on explicit Stop. Viewer
 *   disconnects do not cancel decisions or execution.
 * - Per-stream sessions carry the "allow always / auto-approve" decision so the
 *   loop can skip future pauses within the same run.
 */

import type { DecisionReceiptStore } from '../persistence/decisionReceiptRepo.js'
import { createHash } from 'node:crypto'
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'

type DecisionPrompt = Extract<HeadlessStreamEvent, { type: 'permission_required' | 'clarify_required' | 'operation_mode_upgrade_required' | 'tool_request' }>
type Settlement = Extract<HeadlessStreamEvent, { type: 'decision_settled' }>

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
  prompt?: DecisionPrompt
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
  private readonly settlements = new Map<string, { fingerprint: string | null; event: Settlement }>()
  private readonly listeners = new Set<(event: Settlement) => void>()
  private revision = 0
  constructor(private readonly receipts?: DecisionReceiptStore) {}

  subscribe(listener: (event: Settlement) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(streamId: string): { revision: number; pending: DecisionPrompt[] } {
    const prefix = `${streamId}::`
    return { revision: this.revision, pending: [...this.pending.entries()]
      .filter(([key, entry]) => key.startsWith(prefix) && entry.prompt)
      .map(([, entry]) => structuredClone(entry.prompt!)) }
  }

  receipt(streamId: string, toolCallId: string) {
    for (const kind of ['permission', 'operation_mode_upgrade', 'clarify', 'tool_bridge', 'any']) {
      const receipt = this.settlements.get(`${keyFor(streamId, toolCallId)}::${kind}`) ?? this.receipts?.get(streamId, toolCallId, kind)
      if (receipt) return receipt.event
    }
    return undefined
  }

  private fingerprint(decision: Decision): string {
    // Object key order must not turn a lost-response retry into a conflict.
    const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
        .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value
    return createHash('sha256').update(JSON.stringify(canonical(decision))).digest('hex')
  }

  private settled(key: string, decision: Decision | undefined, kind: DecisionKind): void {
    const separator = key.indexOf('::')
    const event: Settlement = { type: 'decision_settled', streamId: key.slice(0, separator),
      toolCallId: key.slice(separator + 2), outcome: decision === undefined ? 'aborted' : 'resolved', revision: ++this.revision }
    const fingerprint = decision === undefined ? null : this.fingerprint(decision)
    try { this.receipts?.save(event, fingerprint, kind) }
    catch { console.warn('[DecisionBroker] Durable receipt unavailable; live settlement continues') }
    this.settlements.set(`${key}::${kind}`, { fingerprint, event })
    // Receipts never recreate a waiter on expiry; an old retry gets a conflict.
    while (this.settlements.size > 4096) this.settlements.delete(this.settlements.keys().next().value!)
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* A disconnected observer cannot prevent settlement. */ }
    }
  }

  /**
   * Suspend on a decision from the client. Rejects with an AbortError if the
   * provided signal aborts (client disconnect). The caller emits the SSE event.
   */
  requestDecision<T extends Decision = Decision>(opts: {
    streamId: string
    toolCallId: string
    kind?: DecisionKind
    prompt?: DecisionPrompt
    signal?: AbortSignal
  }): Promise<T> {
    const { streamId, toolCallId, kind = 'any', signal } = opts
    const key = keyFor(streamId, toolCallId)

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DecisionAbortedError())
        return
      }

      if (this.settlements.has(`${key}::${kind}`) || this.receipts?.get(streamId, toolCallId, kind)) {
        reject(new Error('Decision identity already settled'))
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
          this.settled(key, undefined, entry.kind)
          entry.reject(new DecisionAbortedError())
        }
      }

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort)
      }

      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      this.revision++
      this.settlements.delete(key)
      this.pending.set(key, {
        kind,
        prompt: opts.prompt ? structuredClone(opts.prompt) : undefined,
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
    if (!entry) return (['permission', 'operation_mode_upgrade', 'clarify', 'tool_bridge', 'any'] as DecisionKind[]).some(kind =>
      decisionMatchesKind(kind, decision) && (this.settlements.get(`${key}::${kind}`) ?? this.receipts?.get(streamId, toolCallId, kind))?.fingerprint === this.fingerprint(decision))
    if (!decisionMatchesKind(entry.kind, decision)) return false

    if (entry.kind === 'permission' && decision === 'allow_always') {
      // Several parallel multi_call workers can already be parked by the time the user
      // answers the one prompt the renderer can display. Atomically promote the stream
      // and release every existing permission waiter. Clarification and operation-mode
      // decisions remain interactive and are deliberately untouched.
      const prefix = `${streamId}::`
      for (const [pendingKey, pendingEntry] of this.pending) {
        if (!pendingKey.startsWith(prefix) || pendingEntry.kind !== 'permission') continue
        this.settled(pendingKey, 'allow_always', pendingEntry.kind)
        this.pending.delete(pendingKey)
        pendingEntry.cleanup()
        pendingEntry.resolve('allow_always')
      }
      this.setAutoApproveAll(streamId)
      return true
    }

    this.settled(key, decision, entry.kind)
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
    this.settled(key, undefined, entry.kind)
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
        this.settled(key, undefined, entry.kind)
        entry.reject(error)
      }
    }
    this.sessions.delete(streamId)
  }

  /** Settle only mode-obsolete waits; ordinary approvals and clarify remain independent. */
  reconcileOperationMode(streamId: string, mode: 'plan' | 'execute', blockedIds: Set<string>): string[] {
    const cleared: string[] = []
    const prefix = `${streamId}::`
    for (const [key, entry] of this.pending) {
      if (!key.startsWith(prefix)) continue
      const id = key.slice(prefix.length)
      if (entry.kind === 'operation_mode_upgrade') {
        this.resolve(streamId, id, mode === 'execute' ? 'switch_to_execute' : 'deny')
        cleared.push(id)
      } else if (entry.kind === 'permission' && mode === 'plan' && blockedIds.has(id)) {
        this.resolve(streamId, id, 'deny')
        cleared.push(id)
      }
    }
    return cleared
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
