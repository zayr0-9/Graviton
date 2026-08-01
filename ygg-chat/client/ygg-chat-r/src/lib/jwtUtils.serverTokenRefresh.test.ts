import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Steer the renderer token-owner flag without touching localStorage.
const flag = vi.hoisted(() => ({ enabled: false }))
vi.mock('../helpers/serverLoopSettings', () => ({
  isServerTokenOwnerEnabled: () => flag.enabled,
}))
// jwtUtils imports the Supabase client at module load; stub it (unused on this path).
vi.mock('./supabase', () => ({ supabase: null }))

import { requestServerTokenRefresh } from './jwtUtils'

describe('requestServerTokenRefresh (Phase 4 Slice 2 delegation)', () => {
  let getFreshAppToken: ReturnType<typeof vi.fn>
  let storageGet: ReturnType<typeof vi.fn>

  beforeEach(() => {
    flag.enabled = false
    getFreshAppToken = vi.fn()
    storageGet = vi.fn()
    ;(globalThis as any).window = {
      electronAPI: { auth: { getFreshAppToken }, storage: { get: storageGet } },
    }
  })
  afterEach(() => {
    delete (globalThis as any).window
    vi.clearAllMocks()
  })

  it('returns false and never calls the server when the renderer flag is off', async () => {
    flag.enabled = false
    expect(await requestServerTokenRefresh(false)).toBe(false)
    expect(getFreshAppToken).not.toHaveBeenCalled()
  })

  it('falls back to self-refresh (false) when the server reports it is not the owner', async () => {
    flag.enabled = true
    getFreshAppToken.mockResolvedValue({ ownerEnabled: false })
    expect(await requestServerTokenRefresh(false)).toBe(false)
    expect(storageGet).not.toHaveBeenCalled()
  })

  it('adopts the server-rotated session into the window cache when owner-enabled', async () => {
    flag.enabled = true
    getFreshAppToken.mockResolvedValue({ ownerEnabled: true, accessToken: 'tok-new' })
    const rotated = {
      user: { id: 'u1' },
      accessToken: 'tok-new',
      session: { access_token: 'tok-new', refresh_token: 'rt2', expires_at: 4102444800 },
    }
    storageGet.mockResolvedValue(rotated)

    const handled = await requestServerTokenRefresh(true)
    expect(handled).toBe(true)
    expect(getFreshAppToken).toHaveBeenCalledWith({ forceRefresh: true })
    expect(storageGet).toHaveBeenCalledWith('auth_session')
    expect((globalThis as any).window._cachedElectronSession).toBe(rotated)
  })

  it('returns false when the Electron IPC surface is unavailable (non-electron)', async () => {
    flag.enabled = true
    ;(globalThis as any).window = {} // no electronAPI
    expect(await requestServerTokenRefresh(false)).toBe(false)
  })

  it('does not self-refresh when owner-enabled but the persisted session is unusable', async () => {
    flag.enabled = true
    // Owner refreshed and handed back a token, but storage has no session row yet.
    getFreshAppToken.mockResolvedValue({ ownerEnabled: true, accessToken: 'tok-new' })
    storageGet.mockResolvedValue(null)
    // Still "handled" (true) because a token exists — the caller must not race the owner.
    expect(await requestServerTokenRefresh(false)).toBe(true)
  })
})
