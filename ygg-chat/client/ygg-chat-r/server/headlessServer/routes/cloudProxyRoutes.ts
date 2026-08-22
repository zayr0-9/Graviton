/**
 * /api/cloud/* — authenticated transparent pass-through to the Railway cloud
 * backend for Railway-authoritative resources (models, users, system-prompts,
 * stripe, app-store, google-drive/oauth).
 *
 * Phase 5, gated behind the `gateway.cloudProxy` flag. It strips the /api/cloud
 * prefix and forwards `<method> <rest+query>` to Railway via RailwayClient
 * (which injects the Bearer + 401-refresh-retry). Railway's status/body are
 * relayed verbatim so cloud errors (e.g. Stripe validation) reach the renderer
 * unchanged. Not a general proxy: only the allowlisted resource prefixes are
 * forwarded, everything else is 403.
 */

import type { Express } from 'express'
import type { RailwayClient } from '../services/railwayClient.js'

export interface RegisterCloudProxyRoutesDeps {
  railway: RailwayClient
  /** Master switch; false (default) keeps this a no-op. */
  enabled?: boolean
}

/** Railway-authoritative resource prefixes the proxy is allowed to forward. */
export const CLOUD_PROXY_ALLOWED_PREFIXES = [
  '/models',
  '/users',
  '/system-prompts',
  '/stripe',
  '/app-store',
  '/oauth',
]

export function isCloudProxyPathAllowed(pathOnly: string): boolean {
  return CLOUD_PROXY_ALLOWED_PREFIXES.some(
    prefix => pathOnly === prefix || pathOnly.startsWith(`${prefix}/`)
  )
}

export function registerCloudProxyRoutes(app: Express, deps: RegisterCloudProxyRoutesDeps): void {
  if (!deps.enabled) return

  app.all('/api/cloud/*', async (req, res) => {
    // originalUrl keeps the query string; strip only the /api/cloud mount prefix.
    const rest = req.originalUrl.replace(/^\/api\/cloud/, '') || '/'
    const pathOnly = rest.split('?')[0]

    if (!isCloudProxyPathAllowed(pathOnly)) {
      res.status(403).json({ error: `cloud proxy: path not allowed (${pathOnly})` })
      return
    }

    const method = req.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE'

    try {
      const result = await deps.railway.passthrough({
        method,
        path: rest,
        body: hasBody ? req.body : undefined,
      })
      if (result.contentType && result.contentType.includes('application/json')) {
        res.status(result.status).json(result.body)
      } else if (typeof result.body === 'string') {
        if (result.contentType) res.type(result.contentType)
        res.status(result.status).send(result.body)
      } else {
        res.status(result.status).json(result.body)
      }
    } catch (err) {
      res.status(502).json({ error: 'cloud proxy failed', detail: String(err) })
    }
  })
}
