/**
 * /api/gw/* — storage-aware gateway handlers for conversations/projects/messages
 * that collapse the renderer's local-vs-cloud (shouldUseLocalApi) branching and
 * dual-fetch/merge into the server, and dual-write on writes.
 *
 * Phase 0 SKELETON. Intentionally NOT mounted in index.ts yet. The real routes
 * land in Phase 5, gated behind the `gateway.crud` flag. No-op today.
 */

import type { Express } from 'express'
import type { RailwayClient } from '../services/railwayClient.js'
import type { CloudMirrorService } from '../services/cloudMirrorService.js'

export interface RegisterGatewayRoutesDeps {
  railway: RailwayClient
  mirror: CloudMirrorService
  /** Master switch; false (default) keeps this a no-op. */
  enabled?: boolean
}

export function registerGatewayRoutes(_app: Express, deps: RegisterGatewayRoutesDeps): void {
  if (!deps.enabled) return
  // Phase 5: mount storage-aware
  //   /api/gw/conversations*, /api/gw/projects*,
  //   /api/gw/conversations/:id/messages, /api/gw/messages/:id
  // that read local SQLite and (for cloud storage_mode) Railway, merge per the
  // renderer's current dual-cursor rule, and dual-write via deps.mirror.
  throw new Error('registerGatewayRoutes is not implemented until Phase 5 (cloud gateway).')
}
