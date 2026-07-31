/**
 * RailwayClient — the single place that knows how to reach the remote Railway
 * cloud backend (base URL + Bearer injection from AppAuthTokenManager) and
 * relays its responses/SSE back to the renderer through the local server.
 *
 * Phase 0 SKELETON. Not wired yet. The real proxy (pass-through + SSE relay
 * incl. free_generations_update / generation_limit_reached, and 401 refresh
 * retry) lands in Phase 4/5. Inert until then.
 */

import type { AppAuthTokenManager } from './appAuthTokenManager.js'

export interface RailwayClientDeps {
  auth: AppAuthTokenManager
  /** Overrides the remote base (defaults to the env-resolved Railway API base). */
  remoteApiBase?: string
}

export interface RailwayRequest {
  method: string
  path: string
  headers?: Record<string, string>
  body?: unknown
}

export interface RailwayClient {
  /** Authenticated JSON pass-through to Railway. */
  request<T = unknown>(req: RailwayRequest): Promise<T>
  /** Authenticated SSE pass-through; each parsed event is handed to `onEvent`. */
  stream(req: RailwayRequest, onEvent: (event: unknown) => void, signal?: AbortSignal): Promise<void>
}

class NotImplementedRailwayClient implements RailwayClient {
  async request<T>(_req: RailwayRequest): Promise<T> {
    throw new Error('RailwayClient.request is not implemented until Phase 4 (cloud gateway).')
  }
  async stream(_req: RailwayRequest, _onEvent: (event: unknown) => void, _signal?: AbortSignal): Promise<void> {
    throw new Error('RailwayClient.stream is not implemented until Phase 4 (cloud gateway).')
  }
}

/** Placeholder factory. Replaced with the real proxying client in Phase 4. */
export function createRailwayClient(_deps: RailwayClientDeps): RailwayClient {
  return new NotImplementedRailwayClient()
}
