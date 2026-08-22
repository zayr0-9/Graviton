// server/server/corsPolicy.ts
// CORS origin policy for the local server. Replaces the former unconditional
// `origin: true` with host-selected behavior:
//   permissive — legacy desktop behavior (reflect every origin);
//   loopback   — reflect only loopback origins (standalone default);
//   allowlist  — reflect only configured origins.
// Requests without an Origin header (curl, same-origin, server-to-server) are
// always allowed; CORS only constrains browser cross-origin access.

import type { YggServerCorsConfig } from './serverConfig.js'

export type CorsOriginCallback = (err: Error | null, allow?: boolean) => void
export type CorsOriginOption = boolean | ((origin: string | undefined, callback: CorsOriginCallback) => void)

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  } catch {
    return false
  }
}

export function buildCorsOriginOption(config: YggServerCorsConfig): CorsOriginOption {
  if (config.mode === 'permissive') {
    return true
  }

  if (config.mode === 'allowlist') {
    const allowed = new Set(config.allowedOrigins)
    return (origin, callback) => {
      if (!origin || allowed.has(origin)) {
        callback(null, true)
        return
      }
      callback(null, false)
    }
  }

  // loopback
  return (origin, callback) => {
    if (!origin || isLoopbackOrigin(origin)) {
      callback(null, true)
      return
    }
    callback(null, false)
  }
}
