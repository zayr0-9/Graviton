import type { IncomingMessage } from 'node:http'
import { tryGetServerConfig } from './serverHost.js'

/** Cross-site browser isolation only, not device authorization. Browser hosts
 * served by this listener and explicitly configured proxy/dev origins work. */
export function allowsClientUpgrade(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin || origin === 'file://') return true // native/extension clients
  try {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    if (url.host === request.headers.host) return true
    const configured = tryGetServerConfig()?.cors.allowedOrigins ?? []
    if (configured.includes(url.origin)) return true
    // Existing Electron Vite development surface; never a remote wildcard.
    return process.env.YGG_CLIENT_DEV_ORIGIN === url.origin && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === '5173'
  } catch { return false }
}
