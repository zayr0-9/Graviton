/**
 * RailwayClient — the single place that knows how to reach the remote Railway
 * cloud backend (base URL + Bearer injection from AppAuthTokenManager) and
 * relays its responses/SSE back to the renderer through the local server.
 *
 * Phase 5: real proxy.
 *  - Base URL resolves via YGG_API_URL → VITE_API_URL → the webdrasil default
 *    (same idiom as openRouterProvider.getRemoteApiBase).
 *  - Every call injects `Authorization: Bearer <app token>` from the single
 *    AppAuthTokenManager; a 401 forces one refresh + retry (the manager is the
 *    sole refresher, so this can never fan out into a token stampede).
 *  - `passthrough` returns Railway's status/body verbatim (no throw on 4xx/5xx)
 *    so /api/cloud/* can mirror cloud errors (e.g. Stripe) to the renderer.
 *  - `request<T>` is the throw-on-error convenience the gateway uses internally.
 *  - `stream` relays SSE frames (parsed JSON) to onEvent, abortable via signal.
 */

import type { AppAuthTokenManager } from './appAuthTokenManager.js'

export interface RailwayClientDeps {
  auth: AppAuthTokenManager
  /** Overrides the remote base (defaults to the env-resolved Railway API base). */
  remoteApiBase?: string
}

export interface RailwayRequest {
  method: string
  /** Path relative to the Railway API base, including any query string. */
  path: string
  headers?: Record<string, string>
  body?: unknown
}

export interface RailwayResponse {
  ok: boolean
  status: number
  /** Parsed JSON when the response is JSON; otherwise the raw text. */
  body: unknown
  contentType: string | null
}

export class RailwayHttpError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`Railway request failed with status ${status}`)
    this.name = 'RailwayHttpError'
    this.status = status
    this.body = body
  }
}

export interface RailwayClient {
  /** Authenticated JSON pass-through to Railway; throws RailwayHttpError on non-2xx. */
  request<T = unknown>(req: RailwayRequest): Promise<T>
  /** Authenticated pass-through that returns Railway's status/body verbatim (never throws on HTTP status). */
  passthrough(req: RailwayRequest): Promise<RailwayResponse>
  /** Authenticated SSE pass-through; each parsed event is handed to `onEvent`. */
  stream(req: RailwayRequest, onEvent: (event: unknown) => void, signal?: AbortSignal): Promise<void>
}

const DEFAULT_REMOTE_API_BASE = 'https://webdrasil-production.up.railway.app/api'

function resolveRemoteApiBase(explicit?: string): string {
  const raw = explicit || process.env.YGG_API_URL || process.env.VITE_API_URL || DEFAULT_REMOTE_API_BASE
  return raw.replace(/\/+$/, '')
}

function joinUrl(base: string, path: string): string {
  return `${base}/${String(path).replace(/^\/+/, '')}`
}

async function parseBody(response: Response): Promise<{ body: unknown; contentType: string | null }> {
  const contentType = response.headers.get('content-type')
  const text = await response.text().catch(() => '')
  if (contentType && contentType.includes('application/json')) {
    try {
      return { body: text ? JSON.parse(text) : null, contentType }
    } catch {
      return { body: text, contentType }
    }
  }
  return { body: text, contentType }
}

class HttpRailwayClient implements RailwayClient {
  private readonly auth: AppAuthTokenManager
  private readonly base: string

  constructor(deps: RailwayClientDeps) {
    this.auth = deps.auth
    this.base = resolveRemoteApiBase(deps.remoteApiBase)
  }

  private async buildHeaders(req: RailwayRequest, accessToken: string | null, streaming: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...(req.headers || {}) }
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
    if (req.body !== undefined && req.body !== null && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (streaming && headers['Accept'] === undefined) headers['Accept'] = 'text/event-stream'
    return headers
  }

  private async doFetch(req: RailwayRequest, forceRefresh: boolean, streaming: boolean, signal?: AbortSignal): Promise<Response> {
    const { accessToken } = await this.auth.getFreshAppToken(forceRefresh ? { forceRefresh: true } : undefined)
    const headers = await this.buildHeaders(req, accessToken, streaming)
    const init: RequestInit = { method: req.method, headers }
    if (req.body !== undefined && req.body !== null) {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    }
    if (signal) init.signal = signal
    return fetch(joinUrl(this.base, req.path), init)
  }

  /** Fetch with one forced-refresh retry on 401. */
  private async fetchWithRetry(req: RailwayRequest, streaming: boolean, signal?: AbortSignal): Promise<Response> {
    let response = await this.doFetch(req, false, streaming, signal)
    if (response.status === 401 && !signal?.aborted) {
      response = await this.doFetch(req, true, streaming, signal)
    }
    return response
  }

  async passthrough(req: RailwayRequest): Promise<RailwayResponse> {
    const response = await this.fetchWithRetry(req, false)
    const { body, contentType } = await parseBody(response)
    return { ok: response.ok, status: response.status, body, contentType }
  }

  async request<T>(req: RailwayRequest): Promise<T> {
    const { ok, status, body } = await this.passthrough(req)
    if (!ok) throw new RailwayHttpError(status, body)
    return body as T
  }

  async stream(req: RailwayRequest, onEvent: (event: unknown) => void, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchWithRetry(req, true, signal)
    if (!response.ok) {
      const { body } = await parseBody(response)
      throw new RailwayHttpError(response.status, body)
    }
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (signal?.aborted) break
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE events are separated by a blank line; keep the trailing partial.
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const evt of events) {
          const dataStr = evt
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .join('\n')
          if (!dataStr || dataStr === '[DONE]') continue
          try {
            onEvent(JSON.parse(dataStr))
          } catch {
            /* skip a malformed frame rather than tearing down the stream */
          }
        }
      }
    } catch (err) {
      // A caller-driven abort is a clean stop, not an error.
      if (!signal?.aborted) throw err
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Factory for the real proxying Railway client. */
export function createRailwayClient(deps: RailwayClientDeps): RailwayClient {
  return new HttpRailwayClient(deps)
}
