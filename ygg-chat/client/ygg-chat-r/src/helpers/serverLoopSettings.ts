/**
 * Feature flag for the server-owned chat loop (thin-client migration).
 *
 * Phase 0 foundation. Default OFF. When enabled, the renderer stops driving the
 * agent loop locally and instead streams from the headless server engine via
 * mainChatClient (wired in Phase 1). Runtime-toggleable (localStorage) so we can
 * dual-run old vs new without a rebuild; a build-time env override is also
 * honored.
 */

const STORAGE_KEY = 'ygg.serverOwnedChatLoop'

function readEnvOverride(): boolean | null {
  try {
    // Vite inlines import.meta.env at build time.
    const raw = (import.meta as any)?.env?.VITE_SERVER_OWNED_CHAT_LOOP
    if (raw === undefined || raw === null || raw === '') return null
    return raw === 'true' || raw === '1' || raw === true
  } catch {
    return null
  }
}

export function isServerOwnedChatLoopEnabled(): boolean {
  const envOverride = readEnvOverride()
  if (envOverride !== null) return envOverride
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setServerOwnedChatLoopEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (enabled) localStorage.setItem(STORAGE_KEY, 'true')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore (storage unavailable)
  }
}
