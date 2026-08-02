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

import { isElectronMode } from '../config/runtimeMode'

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

/**
 * Resumable runs (detach/reattach). Default ON in Electron. When on, the renderer:
 *  - treats a stream drop as a DETACH, not a cancel: it resubscribes to the
 *    server-owned run by streamId (GET /api/streams/:id?fromSeq=…) and replays;
 *  - routes an explicit Stop through POST /api/streams/:id/abort (a bare disconnect
 *    no longer cancels the run server-side);
 *  - re-attaches to in-flight runs after a reload.
 *
 * Coupled to the SERVER flag (gateway.resumableRuns): with the server flag off, the
 * detach/reattach routes 501 and a disconnect still aborts, so turning on only this
 * renderer flag degrades to a harmless no-op (resubscribe fails => treated as ended).
 */
const RESUMABLE_RUNS_STORAGE_KEY = 'ygg.resumableRuns'

function readResumableRunsEnvOverride(): boolean | null {
  try {
    const raw = (import.meta as any)?.env?.VITE_RESUMABLE_RUNS
    if (raw === undefined || raw === null || raw === '') return null
    return raw === 'true' || raw === '1' || raw === true
  } catch {
    return null
  }
}

export function isResumableRunsEnabled(): boolean {
  const envOverride = readResumableRunsEnvOverride()
  if (envOverride !== null) return envOverride
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(RESUMABLE_RUNS_STORAGE_KEY)
      if (stored === 'true') return true
      if (stored === 'false') return false
    }
  } catch {
    // Fall through to the runtime default when storage is unavailable.
  }
  return isElectronMode
}

export function setResumableRunsEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(RESUMABLE_RUNS_STORAGE_KEY, String(enabled))
  } catch {
    // ignore (storage unavailable)
  }
}
