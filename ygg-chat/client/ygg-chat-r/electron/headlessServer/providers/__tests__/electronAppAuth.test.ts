import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProviderTokenStore } from '../tokenStore.js'

const { mockConfGet } = vi.hoisted(() => ({
  mockConfGet: vi.fn(),
}))

vi.mock('conf', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: mockConfGet,
    set: vi.fn(),
  })),
}))

import { readElectronAppAuthSession, syncOpenRouterTokenFromElectronSession } from '../electronAppAuth.js'

describe('electronAppAuth', () => {
  beforeEach(() => {
    mockConfGet.mockReset()
    mockConfGet.mockReturnValue(null)
  })

  it('reads the current auth_session from Electron storage', () => {
    mockConfGet.mockReturnValue({
      session: {
        access_token: 'Bearer latest-app-token',
        user: { id: 'user-123' },
      },
    })

    expect(readElectronAppAuthSession()).toEqual({
      userId: 'user-123',
      accessToken: 'latest-app-token',
      refreshToken: null,
      expiresAt: null,
    })
  })

  it('syncs the latest Electron auth session into the openrouter token store', async () => {
    const tokenStore = new ProviderTokenStore()
    mockConfGet.mockReturnValue({
      userId: 'user-123',
      accessToken: 'fresh-token',
    })

    await syncOpenRouterTokenFromElectronSession(tokenStore)

    expect(tokenStore.get('openrouter', 'user-123')).toMatchObject({
      provider: 'openrouter',
      userId: 'user-123',
      accessToken: 'fresh-token',
    })
  })

  it('preserves refresh token and JWT expiration metadata when syncing OpenRouter token', async () => {
    const tokenStore = new ProviderTokenStore()
    mockConfGet.mockReturnValue({
      userId: 'user-123',
      session: {
        access_token: 'fresh-token',
        refresh_token: 'refresh-token',
        expires_at: 4102444800,
      },
    })

    await syncOpenRouterTokenFromElectronSession(tokenStore)

    expect(tokenStore.get('openrouter', 'user-123')).toMatchObject({
      provider: 'openrouter',
      userId: 'user-123',
      accessToken: 'fresh-token',
      refreshToken: 'refresh-token',
      expiresAt: '2100-01-01T00:00:00.000Z',
    })
  })

  it('ignores placeholder local tokens', async () => {
    const tokenStore = new ProviderTokenStore()
    mockConfGet.mockReturnValue({
      userId: 'user-123',
      accessToken: 'electron-local-token',
    })

    await syncOpenRouterTokenFromElectronSession(tokenStore)

    expect(tokenStore.get('openrouter', 'user-123')).toBeNull()
  })
})
