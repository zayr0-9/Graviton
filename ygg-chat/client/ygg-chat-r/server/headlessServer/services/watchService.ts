import { toolOrchestrator as defaultToolOrchestrator } from '../../tools/orchestrator/index.js'
import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { validateAndResolvePath } from '../../toolPathPolicy.js'
import { withToolAccess } from '../../toolAccessContext.js'
import type { WatchCompletionEvent, WatchState } from '../../../../../shared/watchEvents.js'
import type { ToolExecutionContext, ToolExecutor } from './toolLoopService.js'

type Kind = WatchCompletionEvent['kind']
interface Watch {
  handle: string
  state: WatchState
  kind: Kind
  conversationId: string
  lineageId: string
  messageId: string
  projectId: string | null
  createdAt: string
  completedAt?: string
  timer?: NodeJS.Timeout
  deadlineTimer?: NodeJS.Timeout
  controller: AbortController
  check: () => Promise<boolean>
  streamId?: string | null
  releaseContinuation?: () => void
  delivery?: WatchCompletionEvent['delivery']
}

const integer = (value: unknown, fallback: number, min: number, max: number): number => {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error('Watch numeric option is out of range')
  return Number(value)
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('Watch requires a non-empty string of at most 2048 characters')
  return value
}

// A pathological regular expression must not block the server event loop.
function regexMatch(pattern: string, input: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      try { parentPort.postMessage({ match: new RegExp(workerData.pattern).test(workerData.input) }) }
      catch { parentPort.postMessage({ error: true }) }`, { eval: true, workerData: { pattern, input } })
    let done = false
    const finish = (match?: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      void worker.terminate()
      if (match === undefined) reject(new Error('Regex check failed'))
      else resolve(match)
    }
    const abort = () => finish()
    const timer = setTimeout(abort, 500)
    worker.once('message', result => finish(result.error ? undefined : result.match))
    worker.once('error', abort)
    worker.once('exit', () => { if (!done) finish() })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export class WatchService {
  private watches = new Map<string, Watch>()
  constructor(private notify: (event: WatchCompletionEvent) => void = () => {}) {}
  private continuation?: {
    retain: (context: ToolExecutionContext) => () => void
    deliver: (event: WatchCompletionEvent, streamId: string) => WatchCompletionEvent
  }

  configureContinuation(continuation: NonNullable<WatchService['continuation']>) {
    this.continuation = continuation
  }

  private view(watch: Watch) {
    return { handle: watch.handle, state: watch.state, kind: watch.kind, createdAt: watch.createdAt,
      completedAt: watch.completedAt, delivery: watch.delivery, ...(watch.state === 'error' ? { error: 'Watch check failed; condition details are omitted.' } : {}) }
  }

  execute(args: Record<string, any>, context: ToolExecutionContext, projectId: string | null = null): Record<string, any> {
    if (!context.conversationId || !context.lineageId || !context.messageId) throw new Error('Watcher requires conversation branch context')
    const owned = (w: Watch) => w.conversationId === context.conversationId && w.lineageId === context.lineageId
    if (args.action === 'list') return { success: true, watches: [...this.watches.values()].filter(owned).map(w => this.view(w)) }
    if (args.action === 'status' || args.action === 'cancel') {
      const watch = this.watches.get(args.handle)
      if (!watch || !owned(watch)) throw new Error('No watch owned by this branch has that handle')
      if (args.action === 'cancel') this.finish(watch, 'cancelled')
      return { success: true, ...this.view(watch) }
    }
    if (args.action !== 'start') throw new Error('Use start, status, cancel, or list')
    // Bound both retained output and background resource consumption. Terminal rows
    // are evicted oldest-first only when capacity is needed.
    for (const [id, w] of this.watches) {
      if (this.watches.size < 256) break
      if (w.state !== 'waiting') this.watches.delete(id)
    }
    if (this.watches.size >= 256 || [...this.watches.values()].filter(w => owned(w) && w.state === 'waiting').length >= 16) {
      throw new Error('Watch capacity reached')
    }
    // Keep branch list bounded to 32, without evicting active watches.
    const branchRows = [...this.watches.values()].filter(owned)
    if (branchRows.length >= 32) {
      const terminal = branchRows.find(w => w.state !== 'waiting')
      if (terminal) this.watches.delete(terminal.handle)
    }
    const timeout = integer(args.timeoutMs, 300000, 100, 86400000)
    const interval = integer(args.checkIntervalMs, 1000, 100, 60000)
    const controller = new AbortController()
    const check = this.condition(args, context, controller.signal)
    const watch: Watch = { handle: randomUUID(), state: 'waiting', kind: args.kind,
      conversationId: context.conversationId, lineageId: context.lineageId, messageId: context.messageId,
      projectId, createdAt: new Date().toISOString(), controller, check, streamId: context.streamId }
    if (this.continuation) watch.releaseContinuation = this.continuation.retain(context)
    this.watches.set(watch.handle, watch)
    watch.deadlineTimer = setTimeout(() => this.finish(watch, 'timed_out'), timeout)
    watch.deadlineTimer.unref()
    const tick = async () => {
      try {
        if (await check()) this.finish(watch, 'triggered')
      } catch { this.finish(watch, 'error') }
      if (watch.state === 'waiting') {
        watch.timer = setTimeout(tick, interval)
        watch.timer.unref()
      }
    }
    watch.timer = setTimeout(tick, 0)
    watch.timer.unref()
    return { success: true, ...this.view(watch), notification: this.continuation ? 'queued_user_message' : 'visible_only', autoResume: Boolean(this.continuation) }
  }

  private finish(watch: Watch, state: Exclude<WatchState, 'waiting'>) {
    if (watch.state !== 'waiting') return
    watch.state = state
    watch.completedAt = new Date().toISOString()
    clearTimeout(watch.timer)
    clearTimeout(watch.deadlineTimer)
    watch.controller.abort()
    try {
      if (state !== 'cancelled') {
        const { handle, kind, conversationId, lineageId, messageId, projectId, completedAt } = watch
        let event: WatchCompletionEvent = { handle, kind, conversationId, lineageId, messageId, projectId, completedAt, state }
        if (this.continuation && watch.streamId) {
          try { event = this.continuation.deliver(event, watch.streamId) }
          catch { event = { ...event, delivery: 'failed' } }
        }
        watch.delivery = event.delivery
        try { this.notify(event) } catch { /* Transport loss never changes the terminal result. */ }
      }
    } finally {
      watch.releaseContinuation?.()
      watch.releaseContinuation = undefined
    }
  }

  private condition(args: Record<string, any>, context: ToolExecutionContext, signal: AbortSignal): () => Promise<boolean> {
    if (args.kind === 'process_exit') {
      const pid = integer(args.pid, 0, 1, 2147483647)
      if (!pid) throw new Error('pid is required')
      return async () => {
        try { process.kill(pid, 0); return false }
        catch (error: any) { if (error.code === 'ESRCH') return true; if (error.code === 'EPERM') return false; throw error }
      }
    }
    if (args.kind === 'http_status') {
      const url = new URL(text(args.url))
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use HTTP(S) without embedded credentials')
      const expected = integer(args.expectedStatus, 200, 100, 599)
      return async () => {
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(abort, 5000)
        if (signal.aborted) abort()
        try {
          const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
          void response.body?.cancel().catch(() => {})
          return response.status === expected
        } catch { return false } // Connection failures are expected while an endpoint starts.
        finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      }
    }
    if (!['file_created', 'file_changed', 'log_match'].includes(args.kind)) throw new Error('Unknown watch kind')
    const file = withToolAccess(context.fullAccess, () => validateAndResolvePath(text(args.path), context.rootPath ?? undefined))
    let baseline: string | undefined
    let offset = 0
    let identity: string | undefined
    let tail = ''
    const pattern = args.kind === 'log_match' ? text(args.pattern) : ''
    if (args.regex) { try { new RegExp(pattern) } catch { throw new Error('Invalid log regex') } }
    return async () => {
      let info
      try { info = await stat(file) }
      catch (error: any) { if (error.code === 'ENOENT') return false; throw error }
      if (signal.aborted) return false
      if (!info.isFile()) throw new Error('Watch target is not a regular file')
      if (args.kind === 'file_created') return true
      const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
      if (args.kind === 'file_changed') {
        if (baseline === undefined) { baseline = fingerprint; return false }
        return fingerprint !== baseline
      }
      const currentIdentity = `${info.dev}:${info.ino}`
      if (identity !== currentIdentity || info.size < offset) { offset = 0; tail = ''; identity = currentIdentity }
      if (info.size <= offset) return false
      const handle = await open(file, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(65536, info.size - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        offset += bytesRead
        const input = tail + buffer.subarray(0, bytesRead).toString('utf8')
        tail = input.slice(-4096)
        return args.regex ? await regexMatch(pattern, input, signal) : input.includes(pattern)
      } finally { await handle.close() }
    }
  }

  shutdown() {
    for (const watch of this.watches.values()) this.finish(watch, 'cancelled')
    this.watches.clear()
    this.continuation = undefined
  }
}

export const watchService = new WatchService(event => defaultToolOrchestrator.publishWatchCompletion(event))
export function createWatchExecutor(leaf: ToolExecutor, service: WatchService, projectFor: (id: string) => string | null): ToolExecutor {
  return async (call, context) => {
    if (call.name !== 'watcher') return leaf(call, context)
    if (context.signal?.aborted) throw new Error('Watch registration aborted')
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    return service.execute(args ?? {}, context, projectFor(context.conversationId))
  }
}
