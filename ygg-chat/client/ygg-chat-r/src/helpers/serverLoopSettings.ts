/**
 * Server-owned-loop related runtime settings.
 *
 * Phase 6 cutover: the renderer is now a pure thin client — the 3 chat thunks
 * always route through the server-owned loop in Electron, so the former
 * `isServerOwnedChatLoopEnabled()` / `isCloudServerLoopEnabled()` gates (and their
 * localStorage/env overrides) have been removed along with the legacy client loop.
 *
 * What remains here is the independent token-owner slice (Phase 4 Slice 2), whose
 * flag is still consumed by the renderer's auth-refresh delegation.
 */

/**
 * Phase 4 Slice 2: make the server the SOLE Supabase-token refresher.
 *
 * Default OFF. When on, the renderer stops calling `supabase.auth.refreshSession`
 * itself (both the AuthContext periodic timer via ElectronAuthProvider.refreshToken
 * and the on-demand refreshTokenIfNeeded) and instead delegates to the in-process
 * single-flight AppAuthTokenManager over IPC, then adopts the rotated session the
 * server persisted. This removes the renderer↔server refresh-token rotation race.
 *
 * Coupling is enforced at runtime, not by this flag alone: the IPC handler returns
 * `ownerEnabled: false` unless the SERVER flag (`gateway.tokenOwner`) is also on, and
 * the renderer falls back to self-refresh in that case — so turning on only this flag
 * is a safe no-op, never a half-rollout that starves auth.
 */
const TOKEN_OWNER_STORAGE_KEY = 'ygg.serverTokenOwner'

function readTokenOwnerEnvOverride(): boolean | null {
  try {
    const raw = (import.meta as any)?.env?.VITE_SERVER_TOKEN_OWNER
    if (raw === undefined || raw === null || raw === '') return null
    return raw === 'true' || raw === '1' || raw === true
  } catch {
    return null
  }
}

export function isServerTokenOwnerEnabled(): boolean {
  const envOverride = readTokenOwnerEnvOverride()
  if (envOverride !== null) return envOverride
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TOKEN_OWNER_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setServerTokenOwnerEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (enabled) localStorage.setItem(TOKEN_OWNER_STORAGE_KEY, 'true')
    else localStorage.removeItem(TOKEN_OWNER_STORAGE_KEY)
  } catch {
    // ignore (storage unavailable)
  }
}
