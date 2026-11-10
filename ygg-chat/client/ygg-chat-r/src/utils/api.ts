// utils/api.ts
import { ConversationId } from '../../../../shared/types'
import { isHostClient, isBrowserClient, isNativeShell, isStandaloneClient } from '../platform/clientCapabilities'
import { getHostRuntime, verifyBrowserHost } from '../services/hostRuntimeBootstrap'
import { logClientError } from '../services/clientTelemetry'

// Base configuration
// Derived from the build target (no .env needed). Prefer the clientCapabilities flags in new code.
export const environment: 'electron' | 'browser-client' | 'standalone' | 'local' = isNativeShell
  ? 'electron'
  : isBrowserClient
    ? 'browser-client'
    : isStandaloneClient
      ? 'standalone'
      : 'local'
const DEFAULT_LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:3002'
// Explicit development override for the Ygg server origin (browser targets).
const CONFIGURED_LOCAL_SERVER_ORIGIN = ((): string | null => {
  const raw = import.meta.env.VITE_YGG_SERVER_ORIGIN
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
})()
const LOCAL_SERVER_STATUS_CACHE_TTL_MS = 15000
const LOCAL_SERVER_STATUS_TIMEOUT_MS = 3000

export const LOCAL_API_BASE = `${DEFAULT_LOCAL_SERVER_ORIGIN}/api`

const NETWORK_FAILURE_LOGGED_SYMBOL = Symbol('networkFailureLogged')

type LoggedNetworkError = Error & {
  [NETWORK_FAILURE_LOGGED_SYMBOL]?: boolean
}

type ApiErrorPayload = {
  error?: unknown
  message?: unknown
}

export class LocalApiError extends Error {
  status?: number
  statusText?: string
  payload?: unknown

  constructor(message: string, options: { status?: number; statusText?: string; payload?: unknown } = {}) {
    super(message)
    this.name = 'LocalApiError'
    this.status = options.status
    this.statusText = options.statusText
    this.payload = options.payload
  }
}

type NetworkFailureInput = {
  source: string
  endpoint: string
  method: string
  message: string
  status?: number
  statusText?: string
  durationMs?: number
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function createLocalApiHttpError(response: Response): Promise<LocalApiError> {
  let payload: unknown
  let responseText: string | undefined

  try {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      payload = await response.json()
    } else {
      responseText = await response.text()
      if (responseText) {
        try {
          payload = JSON.parse(responseText)
        } catch {
          // Keep text fallback below.
        }
      }
    }
  } catch {
    // Ignore body parsing failures and use the HTTP status fallback.
  }

  const apiPayload = payload && typeof payload === 'object' ? (payload as ApiErrorPayload) : undefined
  const serverMessage =
    typeof apiPayload?.error === 'string'
      ? apiPayload.error
      : typeof apiPayload?.message === 'string'
        ? apiPayload.message
        : undefined
  const message = serverMessage || responseText || `HTTP ${response.status}: ${response.statusText}`

  return new LocalApiError(message, {
    status: response.status,
    statusText: response.statusText,
    payload,
  })
}

function markNetworkFailureLogged(error: unknown): void {
  if (error && typeof error === 'object') {
    ;(error as LoggedNetworkError)[NETWORK_FAILURE_LOGGED_SYMBOL] = true
  }
}

function isNetworkFailureLogged(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return Boolean((error as LoggedNetworkError)[NETWORK_FAILURE_LOGGED_SYMBOL])
}

function reportNetworkFailure(input: NetworkFailureInput): void {
  logClientError({
    type: 'network_error',
    source: input.source,
    endpoint: input.endpoint,
    method: input.method,
    status: input.status,
    statusText: input.statusText,
    durationMs: input.durationMs,
    message: input.message,
  })
}

export interface LocalServerStatus {
  localServerRunning: boolean
  localServerPort: number | null
  localServerUrl: string | null
  localServerLanUrl: string | null
  localServerError?: string | null
  /**
   * Something is listening on our port but it is NOT this instance's local server
   * (another copy of the app, or an unrelated process). Writing to it is a
   * cross-instance data hazard, so callers must treat this as harder-than-down.
   */
  localServerForeign?: boolean
}

let cachedLocalServerStatus: LocalServerStatus | null = null
let cachedLocalServerStatusAt = 0
let pendingLocalServerStatusRequest: Promise<LocalServerStatus> | null = null
// Set when the `sync:status` IPC itself failed/timed out. Deliberately separate from
// `cachedLocalServerStatus`: we keep the last KNOWN-GOOD origin (better than falling
// back to the hardcoded :3002, which may be another instance) but stop calling it verified.
let lastLocalServerStatusProbeFailed = false

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) return '/'
  return endpoint.startsWith('/') ? endpoint : `/${endpoint}`
}


function normalizeOrigin(origin: string | null | undefined): string | null {
  if (!origin || typeof origin !== 'string') return null
  const trimmed = origin.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

function isElectronRuntimeWithSyncIpc(): boolean {
  if (!isNativeShell) return false
  if (typeof window === 'undefined') return false
  return typeof window.electronAPI?.sync?.status === 'function'
}

/**
 * True when this renderer targets the local Ygg server: the Electron desktop
 * app (origin discovered over sync:status IPC) or the standalone browser
 * target (same-origin/configured). Server-owned chat flows gate on this, not
 * on Electron specifically.
 */
export function isLocalServerRuntime(): boolean {
  return isHostClient
}

/**
 * Origin used when no Electron IPC discovery is available, in precedence
 * order: explicit configured origin (development) -> same-origin for the
 * standalone browser target -> loopback default (local development).
 */
function resolveBrowserFallbackOrigin(): string {
  if (isBrowserClient && typeof window !== 'undefined') return window.location.origin
  if (CONFIGURED_LOCAL_SERVER_ORIGIN) return CONFIGURED_LOCAL_SERVER_ORIGIN
  if (isStandaloneClient && typeof window !== 'undefined') {
    const sameOrigin = normalizeOrigin(window.location.origin)
    if (sameOrigin) return sameOrigin
  }
  return DEFAULT_LOCAL_SERVER_ORIGIN
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise
      .then(result => {
        clearTimeout(timeoutId)
        resolve(result)
      })
      .catch(error => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

function getDefaultLocalServerStatus(): LocalServerStatus {
  return {
    localServerRunning: false,
    localServerPort: null,
    localServerUrl: null,
    localServerLanUrl: null,
    localServerError: null,
    localServerForeign: false,
  }
}

function normalizeLocalServerStatus(raw: Partial<LocalServerStatus> | null | undefined): LocalServerStatus {
  const normalizedUrl = normalizeOrigin(raw?.localServerUrl)
  const normalizedLanUrl = normalizeOrigin(raw?.localServerLanUrl)
  const normalizedPort =
    typeof raw?.localServerPort === 'number' && Number.isInteger(raw.localServerPort) ? raw.localServerPort : null

  return {
    localServerRunning: Boolean(raw?.localServerRunning),
    localServerPort: normalizedPort,
    localServerUrl: normalizedUrl,
    localServerLanUrl: normalizedLanUrl,
    localServerError: raw?.localServerError ?? null,
    localServerForeign: Boolean(raw?.localServerForeign),
  }
}

async function fetchLocalServerStatus(forceRefresh = false): Promise<LocalServerStatus> {
  if (!isElectronRuntimeWithSyncIpc()) {
    return getDefaultLocalServerStatus()
  }

  const now = Date.now()
  if (!forceRefresh && cachedLocalServerStatus && now - cachedLocalServerStatusAt < LOCAL_SERVER_STATUS_CACHE_TTL_MS) {
    return cachedLocalServerStatus
  }

  if (!forceRefresh && pendingLocalServerStatusRequest) {
    return pendingLocalServerStatusRequest
  }

  pendingLocalServerStatusRequest = withTimeout(window.electronAPI!.sync.status(), LOCAL_SERVER_STATUS_TIMEOUT_MS)
    .then(status => {
      const normalized = normalizeLocalServerStatus(status)
      cachedLocalServerStatus = normalized
      cachedLocalServerStatusAt = Date.now()
      lastLocalServerStatusProbeFailed = false
      return normalized
    })
    .catch(error => {
      lastLocalServerStatusProbeFailed = true
      const fallback = getDefaultLocalServerStatus()
      fallback.localServerError = error instanceof Error ? error.message : String(error)
      return fallback
    })
    .finally(() => {
      pendingLocalServerStatusRequest = null
    })

  return pendingLocalServerStatusRequest
}

export async function refreshLocalServerStatus(): Promise<LocalServerStatus> {
  return fetchLocalServerStatus(true)
}

export async function getLocalServerOrigin(): Promise<string> {
  const status = await fetchLocalServerStatus()
  return normalizeOrigin(status.localServerUrl) || resolveBrowserFallbackOrigin()
}

export async function getLocalServerLanOrigin(): Promise<string | null> {
  const status = await fetchLocalServerStatus()
  return normalizeOrigin(status.localServerLanUrl)
}

export function getCachedLocalServerOrigin(): string {
  return normalizeOrigin(cachedLocalServerStatus?.localServerUrl) || resolveBrowserFallbackOrigin()
}

/**
 * Whether the origin we are about to talk to was actually reported by OUR main
 * process, as opposed to the hardcoded `http://127.0.0.1:3002` guess.
 *
 * This matters: when the `sync:status` IPC times out we silently fall back to
 * :3002, which may be a DIFFERENT app instance's server — a cross-instance data
 * hazard. `sync:status` now live-probes `/api/health` and only reports
 * `localServerRunning: true` when its OWN server answers, so this predicate is
 * the renderer's signal that the endpoint is trustworthy.
 *
 * The fallback itself is unchanged (removing it would break every caller); this
 * is the hook a caller uses to refuse or warn instead of writing blind.
 */
export function isLocalServerOriginVerified(): boolean {
  if (isBrowserClient) return Boolean(getHostRuntime())
  if (lastLocalServerStatusProbeFailed) return false
  return Boolean(cachedLocalServerStatus?.localServerRunning && normalizeOrigin(cachedLocalServerStatus?.localServerUrl))
}

/** The origin plus whether it is verified, for callers that must branch on both. */
export function getLocalServerOriginInfo(): { origin: string; verified: boolean } {
  return { origin: getCachedLocalServerOrigin(), verified: isLocalServerOriginVerified() }
}

export function getCachedLocalServerLanOrigin(): string | null {
  return normalizeOrigin(cachedLocalServerStatus?.localServerLanUrl)
}

export async function getLocalApiBase(): Promise<string> {
  const origin = await getLocalServerOrigin()
  return `${origin}/api`
}

export function getCachedLocalApiBase(): string {
  return `${getCachedLocalServerOrigin()}/api`
}

export async function buildLocalApiUrl(endpoint: string): Promise<string> {
  if (isBrowserClient) await verifyBrowserHost()
  return `${await getLocalApiBase()}${normalizeEndpoint(endpoint)}`
}

export function buildCachedLocalApiUrl(endpoint: string): string {
  return `${getCachedLocalApiBase()}${normalizeEndpoint(endpoint)}`
}

export async function buildLocalWebSocketUrl(pathname: string): Promise<string> {
  const origin = await getLocalServerOrigin()
  return `${origin.replace(/^http/i, 'ws')}${normalizeEndpoint(pathname)}`
}

export function buildCachedLocalWebSocketUrl(pathname: string): string {
  return `${getCachedLocalServerOrigin().replace(/^http/i, 'ws')}${normalizeEndpoint(pathname)}`
}

// ---------------------------------------------------------------------------
// Local-API failure classification (shared judgement, no behaviour of its own)
//
// `handleLocalApiError` below produces the friendliest local-server message in
// the app, but it is reachable ONLY through the `localApi` wrapper. Paths that
// use raw `fetch` (the chat/streaming path) used to re-derive this — badly — and
// ended up surfacing the browser's useless "Failed to fetch".
//
// These exports are the judgement, extracted so every path agrees. They are pure
// predicates: they throw nothing, log nothing, and no existing caller changes
// behaviour because `handleLocalApiError` now delegates to them verbatim.
// ---------------------------------------------------------------------------

/**
 * True when the request never reached a server at all.
 *
 * `fetch` rejects with a `TypeError` for DNS/refused-connection/CORS-preflight
 * style failures — for a loopback URL that means the local server is not
 * listening. Anything that produced an HTTP response (any status) is NOT this.
 */
export function isLocalServerUnreachableError(error: unknown): boolean {
  return error instanceof TypeError && error.message.includes('fetch')
}

/** The user-safe prose for an unreachable local server. The one wording, in one place. */
export function getLocalServerUnreachableMessage(base: string = getCachedLocalApiBase()): string {
  return (
    `Local server not available at ${base}. ` +
    `Please ensure the Electron app is running with the local server enabled.`
  )
}

/**
 * `unreachable` - no server answered; retrying once it is up will work.
 * `http`        - a server answered with a non-2xx; `status` is meaningful.
 * `unknown`     - anything else (aborts, JSON parse failures, programming errors).
 */
export type LocalApiFailureKind = 'unreachable' | 'http' | 'unknown'

export interface LocalApiFailure {
  kind: LocalApiFailureKind
  /**
   * For `unreachable` this is user-safe prose. For `http`/`unknown` it is RAW
   * technical text — callers that render to a user must treat it as `detail`
   * and supply their own user-facing wording.
   */
  message: string
  status?: number
  statusText?: string
  payload?: unknown
}

/**
 * Classify anything caught around a local-server request, whether it came from
 * `localApi` (a `LocalApiError`) or from a raw `fetch` (a `TypeError`).
 */
export function classifyLocalApiFailure(error: unknown): LocalApiFailure {
  if (isLocalServerUnreachableError(error)) {
    return { kind: 'unreachable', message: getLocalServerUnreachableMessage() }
  }

  if (error instanceof LocalApiError) {
    return {
      kind: 'http',
      message: error.message,
      status: error.status,
      statusText: error.statusText,
      payload: error.payload,
    }
  }

  return { kind: 'unknown', message: getErrorMessage(error) }
}

// Local API client (mirrors cloud api object) with error handling
const handleLocalApiError = (error: any, endpoint: string): never => {
  // Check if it's a network error (server unavailable)
  if (isLocalServerUnreachableError(error)) {
    throw new Error(getLocalServerUnreachableMessage())
  }

  if (error instanceof LocalApiError) {
    throw new LocalApiError(`Local API error (${endpoint}): ${error.message}`, {
      status: error.status,
      statusText: error.statusText,
      payload: error.payload,
    })
  }

  // Re-throw other errors
  throw new Error(`Local API error (${endpoint}): ${error.message || 'Unknown error'}`)
}

export const localApi = {
  get: async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
    const requestStart = Date.now()
    const method = 'GET'

    try {
      const response = await fetch(await buildLocalApiUrl(endpoint), { ...options, method })
      if (!response.ok) {
        const error = await createLocalApiHttpError(response)
        markNetworkFailureLogged(error)
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - requestStart,
          message: error.message,
        })
        throw error
      }
      return (await response.json()) as T
    } catch (error) {
      if (!isNetworkFailureLogged(error)) {
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          durationMs: Date.now() - requestStart,
          message: getErrorMessage(error),
        })
      }
      return handleLocalApiError(error, endpoint)
    }
  },

  post: async <T>(endpoint: string, data?: any, options?: RequestInit): Promise<T> => {
    const requestStart = Date.now()
    const method = 'POST'
    // FormData (multipart uploads) is passed through untouched — never JSON-encoded —
    // and we let fetch set the multipart Content-Type + boundary itself.
    const isFormData = data && typeof FormData !== 'undefined' && data instanceof FormData

    try {
      const response = await fetch(await buildLocalApiUrl(endpoint), {
        ...options,
        method,
        headers: { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers },
        body: isFormData ? data : data ? JSON.stringify(data) : undefined,
      })
      if (!response.ok) {
        const error = await createLocalApiHttpError(response)
        markNetworkFailureLogged(error)
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - requestStart,
          message: error.message,
        })
        throw error
      }
      return (await response.json()) as T
    } catch (error) {
      if (!isNetworkFailureLogged(error)) {
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          durationMs: Date.now() - requestStart,
          message: getErrorMessage(error),
        })
      }
      return handleLocalApiError(error, endpoint)
    }
  },

  patch: async <T>(endpoint: string, data?: any, options?: RequestInit): Promise<T> => {
    const requestStart = Date.now()
    const method = 'PATCH'

    try {
      const response = await fetch(await buildLocalApiUrl(endpoint), {
        ...options,
        method,
        headers: { 'Content-Type': 'application/json', ...options?.headers },
        body: data ? JSON.stringify(data) : undefined,
      })
      if (!response.ok) {
        const error = await createLocalApiHttpError(response)
        markNetworkFailureLogged(error)
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - requestStart,
          message: error.message,
        })
        throw error
      }
      return (await response.json()) as T
    } catch (error) {
      if (!isNetworkFailureLogged(error)) {
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          durationMs: Date.now() - requestStart,
          message: getErrorMessage(error),
        })
      }
      return handleLocalApiError(error, endpoint)
    }
  },

  put: async <T>(endpoint: string, data?: any, options?: RequestInit): Promise<T> => {
    const requestStart = Date.now()
    const method = 'PUT'

    try {
      const response = await fetch(await buildLocalApiUrl(endpoint), {
        ...options,
        method,
        headers: { 'Content-Type': 'application/json', ...options?.headers },
        body: data ? JSON.stringify(data) : undefined,
      })
      if (!response.ok) {
        const error = await createLocalApiHttpError(response)
        markNetworkFailureLogged(error)
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - requestStart,
          message: error.message,
        })
        throw error
      }
      return (await response.json()) as T
    } catch (error) {
      if (!isNetworkFailureLogged(error)) {
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          durationMs: Date.now() - requestStart,
          message: getErrorMessage(error),
        })
      }
      return handleLocalApiError(error, endpoint)
    }
  },

  delete: async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
    const requestStart = Date.now()
    const method = 'DELETE'

    try {
      const response = await fetch(await buildLocalApiUrl(endpoint), { ...options, method })
      if (!response.ok) {
        const error = await createLocalApiHttpError(response)
        markNetworkFailureLogged(error)
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - requestStart,
          message: error.message,
        })
        throw error
      }
      return (await response.json()) as T
    } catch (error) {
      if (!isNetworkFailureLogged(error)) {
        reportNetworkFailure({
          source: 'localApi',
          endpoint,
          method,
          durationMs: Date.now() - requestStart,
          message: getErrorMessage(error),
        })
      }
      return handleLocalApiError(error, endpoint)
    }
  },
}

/**
 * gwApi (/api/gw/*): the local data gateway (a facade over the host's /api/app/* routes).
 * Reuses localApi's transport, error handling, and network-failure reporting.
 */
function makeLocalGateway(prefix: string) {
  const p = (endpoint: string) => `${prefix}${normalizeEndpoint(endpoint)}`
  return {
    get: <T>(endpoint: string, options?: RequestInit): Promise<T> => localApi.get<T>(p(endpoint), options),
    post: <T>(endpoint: string, data?: any, options?: RequestInit): Promise<T> => localApi.post<T>(p(endpoint), data, options),
    patch: <T>(endpoint: string, data?: any, options?: RequestInit): Promise<T> => localApi.patch<T>(p(endpoint), data, options),
    put: <T>(endpoint: string, data?: any, options?: RequestInit): Promise<T> => localApi.put<T>(p(endpoint), data, options),
    delete: <T>(endpoint: string, options?: RequestInit): Promise<T> => localApi.delete<T>(p(endpoint), options),
  }
}

export const gwApi = makeLocalGateway('/gw')

if (typeof window !== 'undefined' && isNativeShell) {
  void refreshLocalServerStatus().catch(() => {
    // Endpoint discovery is best-effort and can be retried by callers.
  })
}

export type SystemPromptPatchResponse = { id: ConversationId; system_prompt: string | null }

/** Copies a conversation and its full message tree on the host (new ids, local storage). */
export const cloneConversation = (conversationId: ConversationId) =>
  localApi.post<{ id: ConversationId; title: string; project_id: ConversationId | null }>(
    `/app/conversations/${encodeURIComponent(String(conversationId))}/clone`
  )
