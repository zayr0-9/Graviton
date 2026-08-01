// utils/api.ts
import { ConversationId, StorageMode } from '../../../../shared/types'
import { isCommunityMode } from '../config/runtimeMode'
import { clearClaimsCache, getSessionFromStorage, getTokenExpirationTime, refreshTokenIfNeeded } from '../lib/jwtUtils'
import { logClientError } from '../services/clientTelemetry'

// Base configuration
export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'
export const environment = import.meta.env.VITE_ENVIRONMENT || 'local'
const DEFAULT_LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:3002'
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
}

let cachedLocalServerStatus: LocalServerStatus | null = null
let cachedLocalServerStatusAt = 0
let pendingLocalServerStatusRequest: Promise<LocalServerStatus> | null = null

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) return '/'
  return endpoint.startsWith('/') ? endpoint : `/${endpoint}`
}

const PUBLIC_API_ENDPOINT_PREFIXES = ['/app-store/community'] as const

function assertPublicEndpointAllowed(endpoint: string, source: string): string {
  const normalizedEndpoint = normalizeEndpoint(endpoint)
  const allowed = PUBLIC_API_ENDPOINT_PREFIXES.some(
    prefix => normalizedEndpoint === prefix || normalizedEndpoint.startsWith(`${prefix}/`)
  )

  if (!allowed) {
    throw new Error(`[${source}] Endpoint is not whitelisted for public access (${normalizedEndpoint})`)
  }

  return normalizedEndpoint
}

function assertCloudBackendAllowed(endpoint: string, source: string): void {
  if (!isCommunityMode) return
  throw new Error(`[${source}] Cloud backend routes are disabled in community mode (${endpoint})`)
}

function normalizeOrigin(origin: string | null | undefined): string | null {
  if (!origin || typeof origin !== 'string') return null
  const trimmed = origin.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

function isElectronRuntimeWithSyncIpc(): boolean {
  if (environment !== 'electron') return false
  if (typeof window === 'undefined') return false
  return typeof window.electronAPI?.sync?.status === 'function'
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
      return normalized
    })
    .catch(error => {
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
  return normalizeOrigin(status.localServerUrl) || DEFAULT_LOCAL_SERVER_ORIGIN
}

export async function getLocalServerLanOrigin(): Promise<string | null> {
  const status = await fetchLocalServerStatus()
  return normalizeOrigin(status.localServerLanUrl)
}

export function getCachedLocalServerOrigin(): string {
  return normalizeOrigin(cachedLocalServerStatus?.localServerUrl) || DEFAULT_LOCAL_SERVER_ORIGIN
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

// Helper to determine if we should use local API
export function shouldUseLocalApi(storageMode?: StorageMode, env?: string): boolean {
  const runtimeEnv = env || environment
  if (isCommunityMode && runtimeEnv === 'electron') return true
  return storageMode === 'local' && runtimeEnv === 'electron'
}

// Local API client (mirrors cloud api object) with error handling
const handleLocalApiError = (error: any, endpoint: string): never => {
  // Check if it's a network error (server unavailable)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    throw new Error(
      `Local server not available at ${getCachedLocalApiBase()}. ` +
        `Please ensure the Electron app is running with the local server enabled.`
    )
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
 * Phase 5 thin-client gateways. Both hit the LOCAL server (:3002) — the renderer
 * never talks to Railway directly anymore:
 *  - gwApi (/api/gw/*): storage-aware CRUD/reads. The server owns the local-vs-cloud
 *    branch + dual-fetch/merge + dual-write; the renderer just calls one path.
 *  - cloudApi (/api/cloud/*): authenticated pass-through to Railway-authoritative
 *    resources. The server injects the Bearer, so callers pass no token.
 * Both reuse localApi's transport, error handling, and network-failure reporting.
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
export const cloudApi = makeLocalGateway('/cloud')

if (typeof window !== 'undefined' && environment === 'electron') {
  void refreshLocalServerStatus().catch(() => {
    // Endpoint discovery is best-effort and can be retried by callers.
  })
}

/**
 * Ensures the access token is valid before making a request.
 * Automatically refreshes the token if it expires in < 5 minutes.
 *
 * @returns The current valid access token or null
 */
async function ensureValidToken(): Promise<string | null> {
  // Skip for non-web/electron environments (local mode doesn't need token refresh)
  if (environment !== 'web' && environment !== 'electron') {
    return null
  }

  const session = getSessionFromStorage()
  if (!session?.access_token) {
    // console.log('[api] No session found')
    return null
  }

  const expiresIn = getTokenExpirationTime()
  if (expiresIn === null) {
    console.warn('[api] Could not determine token expiration')
    return session.access_token
  }

  // Refresh if token expires in < 5 minutes (300 seconds)
  if (expiresIn < 300) {
    // console.log(`[api] Token expires in ${expiresIn}s, refreshing...`)
    await refreshTokenIfNeeded()
    // Get the refreshed token
    const refreshedSession = getSessionFromStorage()
    return refreshedSession?.access_token || null
  }

  return session.access_token
}

// Flag to prevent multiple concurrent redirects
let isRedirectingToLogin = false

// Custom event name for force logout - AuthContext should listen for this
export const FORCE_LOGOUT_EVENT = 'force-logout'

// Helper function to handle login redirection based on environment
const redirectToLogin = () => {
  // Check if already on login page
  const currentPath = environment === 'electron' ? window.location.hash.replace('#', '') : window.location.pathname

  if (currentPath === '/login' || currentPath.startsWith('/login')) {
    // console.log('[api] Already on login page, skipping redirect')
    return
  }

  // Prevent multiple concurrent redirects
  if (isRedirectingToLogin) {
    // console.log('[api] Redirect already in progress, skipping')
    return
  }

  isRedirectingToLogin = true

  // Clear cached auth state to stop queries from firing with stale tokens
  clearClaimsCache()

  if (typeof window !== 'undefined') {
    // Clear the cached Electron session
    ;(window as any)._cachedElectronSession = null

    // Clear Supabase localStorage to prevent stale tokens
    try {
      localStorage.removeItem('supabase-auth-token')
    } catch (e) {
      // Ignore localStorage errors
    }

    // Dispatch force logout event so AuthContext can clear its React state
    // This prevents the redirect loop where Login.tsx sees stale user state
    window.dispatchEvent(new CustomEvent(FORCE_LOGOUT_EVENT))
  }

  if (environment === 'electron') {
    // In Electron with HashRouter, we need to update the hash
    window.location.hash = '/login'
  } else {
    // In Web with BrowserRouter, we can use href (or assign to origin + /login)
    window.location.href = '/login'
  }

  // Reset the flag after a short delay to allow for page transition
  setTimeout(() => {
    isRedirectingToLogin = false
  }, 2000)
}

// Core API utility function - now accepts accessToken as parameter
export const apiCall = async <T>(endpoint: string, accessToken: string | null, options?: RequestInit): Promise<T> => {
  assertCloudBackendAllowed(endpoint, 'apiCall')

  // Ensure token is valid before making the request
  const validToken = await ensureValidToken()
  const tokenToUse = validToken || accessToken
  const requestStart = Date.now()

  const isFormData = options?.body && typeof FormData !== 'undefined' && options.body instanceof FormData

  // Destructure to separate headers from other options
  const { headers: optionsHeaders, ...restOptions } = options || {}
  const method = String(restOptions.method || 'GET').toUpperCase()

  const makeRequest = async (token: string | null) => {
    return fetch(`${API_BASE}${endpoint}`, {
      ...restOptions, // Spread everything EXCEPT headers
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...optionsHeaders, // Spread headers from options
        ...(token && (environment === 'web' || environment === 'electron') ? { Authorization: `Bearer ${token}` } : {}), // Add Authorization header with JWT in web/electron mode
      },
    })
  }

  const executeRequest = async (token: string | null): Promise<Response> => {
    try {
      return await makeRequest(token)
    } catch (error) {
      reportNetworkFailure({
        source: 'apiCall',
        endpoint,
        method,
        durationMs: Date.now() - requestStart,
        message: getErrorMessage(error),
      })
      throw error
    }
  }

  let response = await executeRequest(tokenToUse)

  // Handle 401 Unauthorized: Try to refresh token and retry once
  if (response.status === 401 && (environment === 'web' || environment === 'electron')) {
    console.warn('[api] Received 401 Unauthorized, attempting token refresh and retry...')

    try {
      // Force refresh the token
      const refreshed = await refreshTokenIfNeeded(true)

      if (refreshed) {
        // Get the new token
        const newSession = getSessionFromStorage()
        const newToken = newSession?.access_token

        if (newToken) {
          // console.log('[api] Token refreshed, retrying request...')
          // Retry the request with the new token
          response = await executeRequest(newToken)

          if (response.status === 401) {
            // Still unauthorized after refresh - redirect to login
            console.error('[api] Still unauthorized after token refresh, redirecting to login...')
            redirectToLogin()
            throw new Error('Session expired. Please log in again.')
          }
        } else {
          console.error('[api] Token refresh succeeded but no token found')
          redirectToLogin()
          throw new Error('Session expired. Please log in again.')
        }
      } else {
        console.error('[api] Token refresh failed, redirecting to login...')
        redirectToLogin()
        throw new Error('Session expired. Please log in again.')
      }
    } catch (error) {
      console.error('[api] Error during token refresh:', error)
      redirectToLogin()
      throw new Error('Session expired. Please log in again.')
    }
  }

  if (!response.ok) {
    const errorText = await response.text()
    reportNetworkFailure({
      source: 'apiCall',
      endpoint,
      method,
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - requestStart,
      message: errorText || response.statusText || `HTTP ${response.status}`,
    })
    throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`)
  }

  return response.json()
}

// Public cloud API utility for explicitly whitelisted read-only endpoints.
// This bypasses community-mode cloud blocking and does not perform auth refresh/redirect behavior.
export const publicApiCall = async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
  const normalizedEndpoint = assertPublicEndpointAllowed(endpoint, 'publicApiCall')
  const requestStart = Date.now()

  const isFormData = options?.body && typeof FormData !== 'undefined' && options.body instanceof FormData
  const { headers: optionsHeaders, ...restOptions } = options || {}
  const method = String(restOptions.method || 'GET').toUpperCase()

  let response: Response
  try {
    response = await fetch(`${API_BASE}${normalizedEndpoint}`, {
      ...restOptions,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...optionsHeaders,
      },
    })
  } catch (error) {
    reportNetworkFailure({
      source: 'publicApiCall',
      endpoint: normalizedEndpoint,
      method,
      durationMs: Date.now() - requestStart,
      message: getErrorMessage(error),
    })
    throw error
  }

  if (!response.ok) {
    const errorText = await response.text()
    reportNetworkFailure({
      source: 'publicApiCall',
      endpoint: normalizedEndpoint,
      method,
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - requestStart,
      message: errorText || response.statusText || `HTTP ${response.status}`,
    })
    throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`)
  }

  return response.json()
}

// Convenience methods for common HTTP operations
export const api = {
  get: <T>(endpoint: string, accessToken: string | null, options?: RequestInit) => {
    // Log all conversation endpoint calls to track duplicate requests
    if (endpoint.includes('/conversations') && !endpoint.includes('/messages')) {
    }
    return apiCall<T>(endpoint, accessToken, { ...options, method: 'GET' })
  },

  post: <T>(endpoint: string, accessToken: string | null, data?: any, options?: RequestInit) =>
    apiCall<T>(endpoint, accessToken, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    }),

  patch: <T>(endpoint: string, accessToken: string | null, data?: any, options?: RequestInit) =>
    apiCall<T>(endpoint, accessToken, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T>(endpoint: string, accessToken: string | null, data?: any, options?: RequestInit) =>
    apiCall<T>(endpoint, accessToken, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T>(endpoint: string, accessToken: string | null, options?: RequestInit) =>
    apiCall<T>(endpoint, accessToken, { ...options, method: 'DELETE' }),
}

// Helper for streaming requests
// Note: Streaming requests always go to cloud server for LLM generation
// The storageMode parameter in the request body tells the server whether to save to cloud DB or not
export const createStreamingRequest = async (
  endpoint: string,
  accessToken: string | null,
  options?: RequestInit
): Promise<Response> => {
  assertCloudBackendAllowed(endpoint, 'createStreamingRequest')

  // Ensure token is valid before making the request
  const validToken = await ensureValidToken()
  const tokenToUse = validToken || accessToken
  const requestStart = Date.now()

  const isFormData = options?.body && typeof FormData !== 'undefined' && options.body instanceof FormData

  // Destructure to separate headers from other options
  const { headers: optionsHeaders, ...restOptions } = options || {}
  const method = String(restOptions.method || 'POST').toUpperCase()

  const makeStreamRequest = async (token: string | null) => {
    const headers = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...optionsHeaders, // Spread the headers from options
      ...(token && (environment === 'web' || environment === 'electron') ? { Authorization: `Bearer ${token}` } : {}),
    }

    return fetch(`${API_BASE}${endpoint}`, {
      ...restOptions, // Spread everything EXCEPT headers
      headers, // Set headers separately
    })
  }

  const executeStreamRequest = async (token: string | null): Promise<Response> => {
    try {
      return await makeStreamRequest(token)
    } catch (error) {
      reportNetworkFailure({
        source: 'createStreamingRequest',
        endpoint,
        method,
        durationMs: Date.now() - requestStart,
        message: getErrorMessage(error),
      })
      throw error
    }
  }

  let response = await executeStreamRequest(tokenToUse)

  // Handle 401 Unauthorized: Try to refresh token and retry once
  if (response.status === 401 && (environment === 'web' || environment === 'electron')) {
    console.warn('[api] Streaming request received 401, attempting token refresh and retry...')

    try {
      // Force refresh the token
      const refreshed = await refreshTokenIfNeeded(true)

      if (refreshed) {
        // Get the new token
        const newSession = getSessionFromStorage()
        const newToken = newSession?.access_token

        if (newToken) {
          // console.log('[api] Token refreshed, retrying streaming request...')
          // Retry the request with the new token
          response = await executeStreamRequest(newToken)

          if (response.status === 401) {
            // Still unauthorized after refresh - redirect to login
            console.error('[api] Streaming request still unauthorized after token refresh')
            redirectToLogin()
            throw new Error('Session expired. Please log in again.')
          }
        } else {
          console.error('[api] Token refresh succeeded but no token found')
          redirectToLogin()
          throw new Error('Session expired. Please log in again.')
        }
      } else {
        console.error('[api] Token refresh failed, redirecting to login...')
        redirectToLogin()
        throw new Error('Session expired. Please log in again.')
      }
    } catch (error) {
      console.error('[api] Error during streaming request token refresh:', error)
      redirectToLogin()
      throw new Error('Session expired. Please log in again.')
    }
  }

  if (!response.ok) {
    reportNetworkFailure({
      source: 'createStreamingRequest',
      endpoint,
      method,
      status: response.status,
      statusText: response.statusText,
      durationMs: Date.now() - requestStart,
      message: response.statusText || `HTTP ${response.status}`,
    })
  }

  return response
}

// Specific helpers for conversation system prompt endpoints
export type SystemPromptGetResponse = { systemPrompt: string | null }
export type SystemPromptPatchResponse = { id: ConversationId; system_prompt: string | null }
export type ConversationPatchResponse = {
  id: ConversationId
  system_prompt?: string | null
  conversation_context?: string | null
}
export type ConversationContextGetResponse = { context: string | null }

export const getConversationSystemPrompt = (conversationId: ConversationId, accessToken: string | null) =>
  api.get<SystemPromptGetResponse>(`/conversations/${conversationId}/system-prompt`, accessToken)

export const getConversationContext = (conversationId: ConversationId, accessToken: string | null) =>
  api.get<ConversationContextGetResponse>(`/conversations/${conversationId}/context`, accessToken)

export const patchConversationSystemPrompt = (
  conversationId: ConversationId,
  systemPrompt: string | null,
  accessToken: string | null
) =>
  api.patch<SystemPromptPatchResponse>(`/conversations/${conversationId}/system-prompt`, accessToken, { systemPrompt })

export const patchConversationContext = (
  conversationId: ConversationId,
  context: string | null,
  accessToken: string | null
) => api.patch<ConversationPatchResponse>(`/conversations/${conversationId}/context`, accessToken, { context })

export const patchConversationResearchNote = (
  conversationId: ConversationId,
  researchNote: string | null,
  accessToken: string | null
) =>
  api.patch<ConversationPatchResponse>(`/conversations/${conversationId}/research-note`, accessToken, { researchNote })

export const patchConversationCwd = (conversationId: ConversationId, cwd: string | null, accessToken: string | null) =>
  api.patch<ConversationPatchResponse>(`/conversations/${conversationId}/cwd`, accessToken, { cwd })

export const patchConversationProject = (
  conversationId: ConversationId,
  projectId: string | null,
  accessToken: string | null
) => api.patch<ConversationPatchResponse>(`/conversations/${conversationId}/project`, accessToken, { projectId })

export const cloneConversation = (conversationId: ConversationId, accessToken: string | null) =>
  api.post<{ id: ConversationId; title: string; project_id: ConversationId | null }>(
    `/conversations/${conversationId}/clone`,
    accessToken
  )

// User System Prompts API
export interface UserSystemPrompt {
  id: string
  owner_id: string
  name: string
  content: string
  description?: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface CreateUserSystemPromptPayload {
  name: string
  content: string
  description?: string | null
  isDefault?: boolean
}

export interface UpdateUserSystemPromptPayload {
  name?: string
  content?: string
  description?: string | null
  isDefault?: boolean
}

// Phase 5: system prompts are Railway-authoritative — routed through the /api/cloud/*
// pass-through (server injects the Bearer). The accessToken param is retained but
// unused so existing call sites need no change.
export const getUserSystemPrompts = (_accessToken?: string | null) =>
  cloudApi.get<UserSystemPrompt[]>('/system-prompts')

export const getUserSystemPromptById = (id: string, _accessToken?: string | null) =>
  cloudApi.get<UserSystemPrompt>(`/system-prompts/${id}`)

export const getDefaultUserSystemPrompt = (_accessToken?: string | null) =>
  cloudApi.get<UserSystemPrompt | null>('/system-prompts/default')

export const createUserSystemPrompt = (data: CreateUserSystemPromptPayload, _accessToken?: string | null) =>
  cloudApi.post<UserSystemPrompt>('/system-prompts', data)

export const updateUserSystemPrompt = (id: string, data: UpdateUserSystemPromptPayload, _accessToken?: string | null) =>
  cloudApi.put<UserSystemPrompt>(`/system-prompts/${id}`, data)

export const setDefaultUserSystemPrompt = (id: string, _accessToken?: string | null) =>
  cloudApi.patch<UserSystemPrompt>(`/system-prompts/${id}/default`)

export const deleteUserSystemPrompt = (id: string, _accessToken?: string | null) =>
  cloudApi.delete<{ message: string; id: string }>(`/system-prompts/${id}`)

export const clearDefaultUserSystemPrompt = (_accessToken?: string | null) =>
  cloudApi.delete<{ message: string }>('/system-prompts/default')

// Stripe Payment API functions
export interface SubscriptionStatus {
  tier: 'high' | 'mid' | 'low' | null
  status: 'active' | 'canceled' | 'past_due' | null
  currentPeriodEnd: string | null
  creditsBalance: number
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  planCode: string | null
  planName: string | null
  monthlyCredits: number
  cancelAtPeriodEnd: boolean
}

export interface TierInfo {
  name: string
  price: number
  priceId: string
  credits: number
  features: string[]
}

export interface PricingInfo {
  tiers: {
    high: TierInfo
    mid: TierInfo
    low: TierInfo
  }
}

export interface CheckoutSessionResponse {
  sessionId: string
  url: string
}

export interface CreditTransaction {
  userId: number
  amount: number
  reason: string
  balanceAfter: number
  createdAt: string
}

/**
 * Create a Stripe Checkout Session for subscription
 */
export const createCheckoutSession = async (
  userId: number,
  tier: 'high' | 'mid' | 'low',
  email?: string
): Promise<CheckoutSessionResponse> => {
  assertCloudBackendAllowed('/stripe/create-checkout-session', 'createCheckoutSession')
  // Railway-authoritative via the /api/cloud/* pass-through (server injects the Bearer).
  return cloudApi.post<CheckoutSessionResponse>('/stripe/create-checkout-session', { userId, tier, email })
}

/**
 * Get user's subscription status and credit balance
 */
export const getSubscriptionStatus = async (userId: number): Promise<SubscriptionStatus> => {
  assertCloudBackendAllowed('/stripe/subscription-status', 'getSubscriptionStatus')
  return cloudApi.get<SubscriptionStatus>(`/stripe/subscription-status?userId=${userId}`)
}

/**
 * Cancel user's subscription (at period end)
 */
export const cancelSubscription = async (userId: number): Promise<{ success: boolean; message: string }> => {
  assertCloudBackendAllowed('/stripe/cancel-subscription', 'cancelSubscription')
  return cloudApi.post<{ success: boolean; message: string }>('/stripe/cancel-subscription', { userId })
}

/**
 * Get user's credit transaction history
 */
export const getCreditHistory = async (
  userId: number,
  limit: number = 100
): Promise<{ history: CreditTransaction[] }> => {
  assertCloudBackendAllowed('/stripe/credit-history', 'getCreditHistory')
  return cloudApi.get<{ history: CreditTransaction[] }>(`/stripe/credit-history?userId=${userId}&limit=${limit}`)
}

/**
 * Get pricing information for all subscription tiers
 */
export const getPricingInfo = async (): Promise<PricingInfo> => {
  assertCloudBackendAllowed('/stripe/pricing-info', 'getPricingInfo')
  return cloudApi.get<PricingInfo>('/stripe/pricing-info')
}
