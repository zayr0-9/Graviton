/**
 * /api/cloud/* — authenticated transparent pass-through to the Railway cloud
 * backend for Railway-authoritative resources (models, users, system-prompts,
 * stripe, app-store, google-drive).
 *
 * Phase 0 SKELETON. Intentionally NOT mounted in index.ts yet. The real routes
 * (delegating to RailwayClient) land in Phase 4, gated behind the
 * `gateway.cloudProxy` flag. Registered only when explicitly enabled so it is a
 * no-op today even if mounted by mistake.
 */

import type { Express } from 'express'
import type { RailwayClient } from '../services/railwayClient.js'

export interface RegisterCloudProxyRoutesDeps {
  railway: RailwayClient
  /** Master switch; false (default) keeps this a no-op. */
  enabled?: boolean
}

export function registerCloudProxyRoutes(_app: Express, deps: RegisterCloudProxyRoutesDeps): void {
  if (!deps.enabled) return
  // Phase 4: mount authenticated pass-through for
  //   GET /api/cloud/models/*, /api/cloud/users/:id, /api/cloud/system-prompts/*,
  //   /api/cloud/stripe/*, /api/cloud/app-store/community/*, /api/cloud/google-drive/*
  // each delegating to deps.railway.request / deps.railway.stream.
  throw new Error('registerCloudProxyRoutes is not implemented until Phase 4 (cloud gateway).')
}
