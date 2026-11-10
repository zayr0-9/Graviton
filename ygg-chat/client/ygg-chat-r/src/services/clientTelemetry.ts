import { isNativeShell } from '../platform/clientCapabilities'

type ClientTelemetryEvent = Record<string, unknown>

type TelemetryState = {
  initialized: boolean
  consolePatched: boolean
  flushInFlight: boolean
  flushTimer: number | null
  queue: string[]
  windowErrorHandler?: (event: ErrorEvent) => void
  unhandledRejectionHandler?: (event: PromiseRejectionEvent) => void
}

type TelemetryWindow = Window & {
  __yggClientTelemetryState?: TelemetryState
}

const MAX_QUEUE_ITEMS = 300
const FLUSH_DEBOUNCE_MS = 1200
const MAX_STRING_LENGTH = 4000
const MAX_ARRAY_LENGTH = 25
const MAX_OBJECT_KEYS = 40
const MAX_DEPTH = 4

function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && isNativeShell
}

function hasClientLogAppender(): boolean {
  if (!isElectronRuntime()) return false
  return Boolean((window as any).electronAPI?.logs?.appendClientError)
}

function getTelemetryState(): TelemetryState {
  const telemetryWindow = window as TelemetryWindow
  if (!telemetryWindow.__yggClientTelemetryState) {
    telemetryWindow.__yggClientTelemetryState = {
      initialized: false,
      consolePatched: false,
      flushInFlight: false,
      flushTimer: null,
      queue: [],
    }
  }

  return telemetryWindow.__yggClientTelemetryState
}

function truncateString(value: string, maxLength = MAX_STRING_LENGTH): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`
}

function isSensitiveKey(key: string): boolean {
  const loweredKey = key.toLowerCase()
  const sensitiveHints = [
    'authorization',
    'token',
    'cookie',
    'secret',
    'password',
    'api_key',
    'apikey',
    'access_token',
    'refresh_token',
  ]

  return sensitiveHints.some(hint => loweredKey.includes(hint))
}

function toSerializable(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    return truncateString(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message),
      stack: value.stack ? truncateString(value.stack, 12000) : undefined,
    }
  }

  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]'
  }

  if (Array.isArray(value)) {
    const normalized = value.slice(0, MAX_ARRAY_LENGTH).map(item => toSerializable(item, depth + 1, seen))
    if (value.length > MAX_ARRAY_LENGTH) {
      normalized.push(`[+${value.length - MAX_ARRAY_LENGTH} more items]`)
    }
    return normalized
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) {
      return '[Circular]'
    }
    seen.add(value as object)

    const normalized: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)

    for (const [index, [key, rawValue]] of entries.entries()) {
      if (index >= MAX_OBJECT_KEYS) {
        normalized.__truncatedKeys = `${entries.length - MAX_OBJECT_KEYS} additional keys omitted`
        break
      }

      normalized[key] = isSensitiveKey(key) ? '[REDACTED]' : toSerializable(rawValue, depth + 1, seen)
    }

    return normalized
  }

  return truncateString(String(value))
}

function enqueueLog(line: string): void {
  const state = getTelemetryState()

  if (state.queue.length >= MAX_QUEUE_ITEMS) {
    state.queue.shift()
  }

  state.queue.push(line)
}

async function appendChunk(content: string): Promise<boolean> {
  try {
    const response = await (window as any).electronAPI?.logs?.appendClientError(content)
    return Boolean(response?.success)
  } catch {
    return false
  }
}

async function flushQueue(): Promise<void> {
  if (!hasClientLogAppender()) return

  const state = getTelemetryState()
  if (state.flushInFlight || state.queue.length === 0) {
    return
  }

  const chunk = state.queue.join('')
  state.queue = []
  state.flushInFlight = true

  try {
    const ok = await appendChunk(chunk)
    if (!ok) {
      state.queue.unshift(chunk)
    }
  } finally {
    state.flushInFlight = false
    if (state.queue.length > 0) {
      scheduleFlush(2000)
    }
  }
}

function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS): void {
  const state = getTelemetryState()

  if (state.flushTimer) {
    window.clearTimeout(state.flushTimer)
  }

  state.flushTimer = window.setTimeout(() => {
    state.flushTimer = null
    void flushQueue()
  }, delayMs)
}
function buildLogLine(event: ClientTelemetryEvent): string {
  const normalizedEvent = toSerializable(event)
  const eventPayload =
    normalizedEvent && typeof normalizedEvent === 'object' && !Array.isArray(normalizedEvent)
      ? (normalizedEvent as Record<string, unknown>)
      : { value: normalizedEvent }

  const payload = {
    ts: new Date().toISOString(),
    runtime: 'electron',
    href: window.location.href,
    ...eventPayload,
  }

  return `${JSON.stringify(payload)}\n`
}

export function logClientError(event: ClientTelemetryEvent): void {
  if (!hasClientLogAppender()) return

  try {
    enqueueLog(buildLogLine(event))
    scheduleFlush()
  } catch {
    // Intentionally swallow to avoid telemetry causing user-facing failures
  }
}

function patchConsoleError(): void {
  const state = getTelemetryState()
  if (state.consolePatched) {
    return
  }

  const originalConsoleError = console.error.bind(console)

  console.error = ((...args: unknown[]) => {
    try {
      logClientError({
        type: 'console_error',
        args: toSerializable(args),
      })
    } catch {
      // Never throw from console patch
    }

    originalConsoleError(...(args as any[]))
  }) as typeof console.error

  state.consolePatched = true
}

export function initClientTelemetry(): void {
  if (!isElectronRuntime() || !hasClientLogAppender()) {
    return
  }

  const state = getTelemetryState()
  if (state.initialized) {
    return
  }

  patchConsoleError()

  state.windowErrorHandler = event => {
    logClientError({
      type: 'window_error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: toSerializable(event.error),
    })
  }

  state.unhandledRejectionHandler = event => {
    logClientError({
      type: 'unhandled_rejection',
      reason: toSerializable(event.reason),
    })
  }

  window.addEventListener('error', state.windowErrorHandler)
  window.addEventListener('unhandledrejection', state.unhandledRejectionHandler)
  window.addEventListener('beforeunload', () => {
    void flushQueue()
  })

  state.initialized = true
}
