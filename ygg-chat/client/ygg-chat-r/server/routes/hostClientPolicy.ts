import { tryGetServerConfig } from '../serverHost.js'
import { isNativeClientFence, nativeClientHeader } from '../nativeClientFence.js'
import type { Request, Response, NextFunction } from 'express'

/** Not authentication: trusted-network prototype. Prevent cross-site browser commands
 * reaching the new host-control surface. Native Electron continues to use trusted IPC. */
export function hostClientPolicy(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin')
  const site = req.get('sec-fetch-site')
  // Electron's preserved loadFile renderer has an opaque file origin. This is
  // a compatibility exception, NOT authentication (sandboxed pages can also be opaque).
  const nativeFileOrigin = origin === 'null' && (req.method === 'GET' || req.method === 'HEAD')
  // Chromium file-loaded fetches can omit Origin but still be cross-site.
  // Only main-injected requests can bypass browser origin matching; opaque
  // app frames must continue to use the parent bridge.
  const nativeClient = isNativeClientFence(req.get(nativeClientHeader))
  const explicitlyAllowed = origin && tryGetServerConfig()?.cors.allowedOrigins.includes(origin)
  if (site === 'cross-site' && !nativeFileOrigin && !nativeClient && !explicitlyAllowed) { res.status(403).json({ error: 'Cross-site host access is not allowed' }); return }
  if (origin && !nativeFileOrigin && !nativeClient) {
    try {
      const parsed = new URL(origin)
      const configured = tryGetServerConfig()?.cors.allowedOrigins.includes(parsed.origin)
      if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.host !== req.get('host') && !configured)) {
        res.status(403).json({ error: 'Host origin mismatch' }); return
      }
    } catch { res.status(403).json({ error: 'Invalid host origin' }); return }
  }
  // A browser form/simple fetch must not mutate host identity. JSON requests from
  // another origin preflight and then fail the exact-origin check above.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !req.is('application/json')) {
    res.status(415).json({ error: 'JSON host command required' }); return
  }
  res.setHeader('Cache-Control', 'no-store')
  next()
}
