import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Controllable electronAppAuth mock so the single-flight refresher can be steered.
const mock = vi.hoisted(() => ({
  session: { userId: null as string | null, accessToken: null as string | null, refreshToken: null as string | null, expiresAt: null as string | null },
  shouldRefresh: false,
  refreshCalls: 0,
  refreshResolvers: [] as Array<() => void>,
  refreshImpl: null as null | (() => Promise<any>),
}))

vi.mock('../../providers/electronAppAuth.js', () => ({
  readElectronAppAuthSession: () => ({ ...mock.session }),
  shouldRefresh: () => mock.shouldRefresh,
  refreshElectronAppAuthSession: (_rt: string) => {
    mock.refreshCalls += 1
    if (mock.refreshImpl) return mock.refreshImpl()
    return Promise.resolve(null)
  },
}))

import { createAppAuthTokenManager } from '../appAuthTokenManager.js'

describe('appAuthTokenManager (single-flight)', () => {
  beforeEach(() => {
    mock.session = { userId: 'u1', accessToken: 'tok-fresh', refreshToken: 'rt1', expiresAt: '2999-01-01T00:00:00Z' }
    mock.shouldRefresh = false
    mock.refreshCalls = 0
    mock.refreshImpl = null
  })
  afterEach(() => vi.clearAllMocks())

  it('returns the current token without refreshing when it is not near expiry', async () => {
    const mgr = createAppAuthTokenManager()
    const t = await mgr.getFreshAppToken()
    expect(t).toEqual({ userId: 'u1', accessToken: 'tok-fresh' })
    expect(mock.refreshCalls).toBe(0)
  })

  it('does not refresh when there is no refresh token even if near expiry', async () => {
    mock.session.refreshToken = null
    mock.shouldRefresh = true
    const mgr = createAppAuthTokenManager()
    await mgr.getFreshAppToken()
    expect(mock.refreshCalls).toBe(0)
  })

  it('refreshes once near expiry and re-reads the rotated session', async () => {
    mock.shouldRefresh = true
    mock.refreshImpl = async () => {
      // Simulate the Conf rotation the real refresher performs.
      mock.session.accessToken = 'tok-rotated'
      return {}
    }
    const mgr = createAppAuthTokenManager()
    const t = await mgr.getFreshAppToken()
    expect(mock.refreshCalls).toBe(1)
    expect(t.accessToken).toBe('tok-rotated')
  })

  it('coalesces concurrent refreshes into a single in-flight call', async () => {
    mock.shouldRefresh = true
    let resolveRefresh: () => void = () => {}
    mock.refreshImpl = () =>
      new Promise<any>(resolve => {
        resolveRefresh = () => {
          mock.session.accessToken = 'tok-rotated'
          resolve({})
        }
      })
    const mgr = createAppAuthTokenManager()
    const p1 = mgr.getFreshAppToken()
    const p2 = mgr.getFreshAppToken()
    const p3 = mgr.getFreshAppToken()
    resolveRefresh()
    const [a, b, c] = await Promise.all([p1, p2, p3])
    // Three concurrent callers, exactly one refresh.
    expect(mock.refreshCalls).toBe(1)
    expect(a.accessToken).toBe('tok-rotated')
    expect(b.accessToken).toBe('tok-rotated')
    expect(c.accessToken).toBe('tok-rotated')
  })

  it('forceRefresh triggers a refresh even when the token is not near expiry', async () => {
    mock.shouldRefresh = false
    mock.refreshImpl = async () => {
      mock.session.accessToken = 'tok-forced'
      return {}
    }
    const mgr = createAppAuthTokenManager()
    const t = await mgr.getFreshAppToken({ forceRefresh: true })
    expect(mock.refreshCalls).toBe(1)
    expect(t.accessToken).toBe('tok-forced')
  })

  it('a fresh refresh is allowed after a prior one settles (inflight cleared)', async () => {
    mock.shouldRefresh = true
    mock.refreshImpl = async () => ({})
    const mgr = createAppAuthTokenManager()
    await mgr.getFreshAppToken()
    await mgr.getFreshAppToken()
    expect(mock.refreshCalls).toBe(2)
  })
})
