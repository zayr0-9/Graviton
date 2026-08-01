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

/**
 * Phase 4 sub-flag: route the CLOUD (openrouter) provider through the server-owned
 * loop too. Default OFF and NESTED under isServerOwnedChatLoopEnabled() at the call
 * sites, so cloud repoint requires BOTH the base server-loop flag and this one. For
 * correct cloud-through-gateway the server must also run gateway.chat (free-tier
 * relay + Railway id adoption); with only this renderer flag on, the server would
 * persist under self-minted ids and never emit the free-tier modal.
 */
const CLOUD_STORAGE_KEY = 'ygg.cloudServerLoop'

function readCloudEnvOverride(): boolean | null {
  try {
    const raw = (import.meta as any)?.env?.VITE_CLOUD_SERVER_LOOP
    if (raw === undefined || raw === null || raw === '') return null
    return raw === 'true' || raw === '1' || raw === true
  } catch {
    return null
  }
}

export function isCloudServerLoopEnabled(): boolean {
  const envOverride = readCloudEnvOverride()
  if (envOverride !== null) return envOverride
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CLOUD_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setCloudServerLoopEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (enabled) localStorage.setItem(CLOUD_STORAGE_KEY, 'true')
    else localStorage.removeItem(CLOUD_STORAGE_KEY)
  } catch {
    // ignore (storage unavailable)
  }
}

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
