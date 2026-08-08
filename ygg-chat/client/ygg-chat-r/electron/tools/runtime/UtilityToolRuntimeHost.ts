import { utilityProcess } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import type { ToolExecutionOptions, UtilityRuntimeRequest, UtilityRuntimeResponse } from './protocol.js'

type PendingRequestKind = 'execute_tool' | 'shutdown' | 'reload_custom_tools'
type UtilityTimeoutCause =
  | 'ready_timeout'
  | 'execution_timeout'
  | 'shutdown_ack_timeout'
  | 'custom_tools_reload_timeout'
  | 'process_exit'
  | 'process_error'

interface UtilityRequestError extends Error {
  requestId?: string
  requestType?: PendingRequestKind | 'ready'
  toolName?: string
  durationMs?: number
  timeoutCause?: UtilityTimeoutCause
  errorCode?: string
}

type PendingRequest = {
  requestId: string
  kind: PendingRequestKind
  toolName?: string
  startedAtMs: number
  timeoutMs: number
  resolve: (value: any) => void
  reject: (reason?: unknown) => void
  timeoutId?: NodeJS.Timeout
}

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 10_000
const SHUTDOWN_ACK_TIMEOUT_MS = 3_000
const CUSTOM_TOOLS_RELOAD_TIMEOUT_MS = 15_000

function resolveUtilityEntryPath(): string {
  return path.join(__dirname, 'toolRuntimeUtility.mjs')
}

function normalizeIncomingMessage(raw: unknown): UtilityRuntimeResponse | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const candidate = raw as any
  if (candidate.type) {
    return candidate as UtilityRuntimeResponse
  }

  if (candidate.data && typeof candidate.data === 'object' && candidate.data.type) {
    return candidate.data as UtilityRuntimeResponse
  }

  return null
}

function formatTelemetry(details: {
  requestId?: string
  requestType?: PendingRequestKind | 'ready'
  toolName?: string
  durationMs?: number
  timeoutCause?: UtilityTimeoutCause
  errorCode?: string
}): string {
  const fields: Array<[string, string | number]> = []

  if (details.requestId) fields.push(['requestId', details.requestId])
  if (details.requestType) fields.push(['requestType', details.requestType])
  if (details.toolName) fields.push(['toolName', details.toolName])
  if (typeof details.durationMs === 'number') fields.push(['durationMs', details.durationMs])
  if (details.timeoutCause) fields.push(['timeoutCause', details.timeoutCause])
  if (details.errorCode) fields.push(['errorCode', details.errorCode])

  return fields.map(([k, v]) => `${k}=${v}`).join(' ')
}

function isUtilityRuntimeDebugLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.YGG_UTILITY_TOOL_RUNTIME_DEBUG_LOGS || '')
}

function createUtilityRequestError(
  message: string,
  details: {
    requestId?: string
    requestType?: PendingRequestKind | 'ready'
    toolName?: string
    durationMs?: number
    timeoutCause?: UtilityTimeoutCause
    errorCode?: string
  }
): UtilityRequestError {
  const telemetry = formatTelemetry(details)
  const error = new Error(telemetry ? `${message} (${telemetry})` : message) as UtilityRequestError
  error.requestId = details.requestId
  error.requestType = details.requestType
  error.toolName = details.toolName
  error.durationMs = details.durationMs
  error.timeoutCause = details.timeoutCause
  error.errorCode = details.errorCode
  return error
}

export class UtilityToolRuntimeHost {
  private process: Electron.UtilityProcess | null = null
  private pending = new Map<string, PendingRequest>()
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((reason?: unknown) => void) | null = null
  private readyTimeoutId: NodeJS.Timeout | null = null

  private logLifecycle(event: string, details: Record<string, unknown>, level: 'log' | 'warn' | 'error' = 'log'): void {
    if (level === 'log' && !isUtilityRuntimeDebugLoggingEnabled()) return
    const detailText = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ')

    const line = detailText ? `[UtilityToolRuntime][host] ${event} ${detailText}` : `[UtilityToolRuntime][host] ${event}`
    if (level === 'warn') {
      console.warn(line)
      return
    }
    if (level === 'error') {
      console.error(line)
      return
    }
    console.log(line)
  }

  async initialize(): Promise<void> {
    if (this.process) {
      if (this.readyPromise) {
        await this.readyPromise
      }
      return
    }

    const modulePath = resolveUtilityEntryPath()
    this.process = utilityProcess.fork(modulePath, [], {
      serviceName: 'ygg-tools-runtime',
      stdio: 'pipe',
    })

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    this.readyTimeoutId = setTimeout(() => {
      const error = createUtilityRequestError('Timed out waiting for utility tool runtime ready signal', {
        requestType: 'ready',
        durationMs: READY_TIMEOUT_MS,
        timeoutCause: 'ready_timeout',
      })
      this.logLifecycle('ready_timeout', { durationMs: READY_TIMEOUT_MS, timeoutCause: 'ready_timeout' }, 'warn')
      this.rejectReady(error)
      try {
        this.process?.kill()
      } catch {
        // noop
      } finally {
        this.process = null
      }
    }, READY_TIMEOUT_MS)

    this.process.on('message', (rawMessage: unknown) => {
      this.handleMessage(rawMessage)
    })

    this.process.stdout?.on('data', chunk => {
      if (!isUtilityRuntimeDebugLoggingEnabled()) return
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      const trimmed = text.trim()
      if (trimmed) {
        console.log(`[UtilityToolRuntime][stdout] ${trimmed}`)
      }
    })

    this.process.stderr?.on('data', chunk => {
      if (!isUtilityRuntimeDebugLoggingEnabled()) return
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      const trimmed = text.trim()
      if (trimmed) {
        console.error(`[UtilityToolRuntime][stderr] ${trimmed}`)
      }
    })

    this.process.on('exit', (code: number) => {
      this.logLifecycle('process_exit', { code, pendingCount: this.pending.size }, 'warn')
      this.rejectAllPending('Utility tool runtime exited unexpectedly', 'process_exit')
      this.rejectReady(
        createUtilityRequestError(`Utility tool runtime exited unexpectedly (code=${code})`, {
          requestType: 'ready',
          timeoutCause: 'process_exit',
        })
      )
      this.process = null
    })

    // Electron types UtilityProcess events as 'spawn' | 'exit' | 'message' only, so
    // 'error' is not in the overload set. Registering it is harmless and preserves
    // existing behaviour if Electron ever emits it.
    ;(this.process as unknown as NodeJS.EventEmitter).on('error', (error: Error) => {
      this.logLifecycle('process_error', { message: error.message, pendingCount: this.pending.size }, 'error')
      this.rejectAllPending(`Utility tool runtime error: ${error.message}`, 'process_error')
      this.rejectReady(
        createUtilityRequestError(`Utility tool runtime error: ${error.message}`, {
          requestType: 'ready',
          timeoutCause: 'process_error',
        })
      )
      this.process = null
    })

    await this.readyPromise
  }

  private resolveReady(): void {
    if (this.readyTimeoutId) {
      clearTimeout(this.readyTimeoutId)
      this.readyTimeoutId = null
    }
    if (this.readyResolve) {
      this.readyResolve()
    }
    this.readyPromise = null
    this.readyResolve = null
    this.readyReject = null
    this.logLifecycle('ready', {})
  }

  private rejectReady(error: unknown): void {
    if (this.readyTimeoutId) {
      clearTimeout(this.readyTimeoutId)
      this.readyTimeoutId = null
    }
    if (this.readyReject) {
      this.readyReject(error)
    }
    this.readyPromise = null
    this.readyResolve = null
    this.readyReject = null
  }

  private rejectAllPending(message: string, timeoutCause: UtilityTimeoutCause): void {
    const pending = Array.from(this.pending.values())
    this.pending.clear()
    for (const req of pending) {
      if (req.timeoutId) clearTimeout(req.timeoutId)
      const durationMs = Date.now() - req.startedAtMs
      req.reject(
        createUtilityRequestError(message, {
          requestId: req.requestId,
          requestType: req.kind,
          toolName: req.toolName,
          durationMs,
          timeoutCause,
        })
      )
    }
  }

  private handleMessage(rawMessage: unknown): void {
    const parsed = normalizeIncomingMessage(rawMessage)
    if (!parsed) {
      console.warn('[UtilityToolRuntime] Received unexpected message shape:', rawMessage)
      return
    }

    if (parsed.type === 'ready') {
      this.resolveReady()
      return
    }

    if (typeof (parsed as any).requestId !== 'string') {
      console.warn('[UtilityToolRuntime] Received message without requestId:', parsed)
      return
    }

    const requestId = (parsed as any).requestId as string
    const pending = this.pending.get(requestId)
    if (!pending) {
      this.logLifecycle('response_without_pending', { requestId, type: parsed.type }, 'warn')
      return
    }

    if (pending.timeoutId) clearTimeout(pending.timeoutId)
    this.pending.delete(requestId)

    const hostDurationMs = Date.now() - pending.startedAtMs

    if (parsed.type === 'tool_result') {
      const durationMs = parsed.telemetry?.durationMs ?? hostDurationMs
      if (parsed.success) {
        this.logLifecycle('request_success', {
          requestId,
          requestType: pending.kind,
          toolName: pending.toolName,
          durationMs,
          handledBy: parsed.telemetry?.handledBy,
        })
        pending.resolve(parsed.result)
      } else {
        this.logLifecycle(
          'request_failed',
          {
            requestId,
            requestType: pending.kind,
            toolName: pending.toolName,
            durationMs,
            errorCode: parsed.errorCode,
            message: parsed.error,
          },
          'warn'
        )
        pending.reject(
          createUtilityRequestError(parsed.error || 'Tool runtime execution failed', {
            requestId,
            requestType: pending.kind,
            toolName: pending.toolName,
            durationMs,
            errorCode: parsed.errorCode,
          })
        )
      }
      return
    }

    if (parsed.type === 'shutdown_ack') {
      this.logLifecycle('shutdown_ack', {
        requestId,
        requestType: pending.kind,
        durationMs: hostDurationMs,
      })
      pending.resolve(undefined)
      return
    }

    if (parsed.type === 'custom_tools_reloaded') {
      const durationMs = typeof parsed.durationMs === 'number' ? parsed.durationMs : hostDurationMs
      if (parsed.success) {
        this.logLifecycle('custom_tools_reloaded', {
          requestId,
          durationMs,
          totalCount: parsed.totalCount,
        })
        pending.resolve({
          success: true,
          totalCount: parsed.totalCount,
          durationMs,
        })
      } else {
        this.logLifecycle(
          'custom_tools_reload_failed',
          {
            requestId,
            durationMs,
            message: parsed.error,
          },
          'warn'
        )
        pending.reject(
          createUtilityRequestError(parsed.error || 'Failed to reload custom tools in utility runtime', {
            requestId,
            requestType: pending.kind,
            durationMs,
          })
        )
      }
    }
  }

  private async sendRequest<T>(
    payload: UtilityRuntimeRequest,
    meta: {
      kind: PendingRequestKind
      timeoutMs: number
      timeoutCause: UtilityTimeoutCause
      toolName?: string
    }
  ): Promise<T> {
    await this.initialize()

    if (!this.process) {
      throw createUtilityRequestError('Utility tool runtime is not available', {
        requestId: payload.requestId,
        requestType: meta.kind,
        toolName: meta.toolName,
      })
    }

    const startedAtMs = Date.now()
    const requestId = payload.requestId

    this.logLifecycle('request_dispatch', {
      requestId,
      requestType: meta.kind,
      toolName: meta.toolName,
      timeoutMs: meta.timeoutMs,
    })

    return await new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.pending.has(requestId)) return
        this.pending.delete(requestId)
        const durationMs = Date.now() - startedAtMs
        const timeoutError = createUtilityRequestError('Utility runtime request timed out', {
          requestId,
          requestType: meta.kind,
          toolName: meta.toolName,
          durationMs,
          timeoutCause: meta.timeoutCause,
        })
        this.logLifecycle(
          'request_timeout',
          {
            requestId,
            requestType: meta.kind,
            toolName: meta.toolName,
            durationMs,
            timeoutCause: meta.timeoutCause,
          },
          'warn'
        )
        reject(timeoutError)
      }, meta.timeoutMs)

      this.pending.set(requestId, {
        requestId,
        kind: meta.kind,
        toolName: meta.toolName,
        startedAtMs,
        timeoutMs: meta.timeoutMs,
        resolve,
        reject,
        timeoutId,
      })

      this.process!.postMessage(payload)
    })
  }

  async executeTool(toolName: string, args: any, options: ToolExecutionOptions = {}): Promise<any> {
    const requestId = uuidv4()
    const payload: UtilityRuntimeRequest = {
      type: 'execute_tool',
      requestId,
      toolName,
      args,
      options,
    }

    return await this.sendRequest<any>(payload, {
      kind: 'execute_tool',
      toolName,
      timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS,
      timeoutCause: 'execution_timeout',
    })
  }

  async reloadCustomTools(reason: string = 'host_sync'): Promise<{ success: boolean; totalCount?: number; durationMs?: number }> {
    const requestId = uuidv4()
    const payload: UtilityRuntimeRequest = {
      type: 'reload_custom_tools',
      requestId,
      reason,
    }

    return await this.sendRequest<{ success: boolean; totalCount?: number; durationMs?: number }>(payload, {
      kind: 'reload_custom_tools',
      timeoutMs: CUSTOM_TOOLS_RELOAD_TIMEOUT_MS,
      timeoutCause: 'custom_tools_reload_timeout',
    })
  }

  async shutdown(): Promise<void> {
    if (!this.process) return

    const requestId = uuidv4()
    const payload: UtilityRuntimeRequest = {
      type: 'shutdown',
      requestId,
    }

    try {
      await this.sendRequest<void>(payload, {
        kind: 'shutdown',
        timeoutMs: SHUTDOWN_ACK_TIMEOUT_MS,
        timeoutCause: 'shutdown_ack_timeout',
      })
    } catch (error) {
      this.logLifecycle(
        'shutdown_ack_failed',
        {
          message: error instanceof Error ? error.message : String(error),
        },
        'warn'
      )
      // Force kill below.
    }

    try {
      this.process.kill()
    } finally {
      this.process = null
      this.readyPromise = null
      this.readyResolve = null
      this.readyReject = null
      if (this.readyTimeoutId) {
        clearTimeout(this.readyTimeoutId)
        this.readyTimeoutId = null
      }
      this.rejectAllPending('Utility runtime shut down', 'process_exit')
    }
  }
}
