import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../store/store', () => ({ store: { dispatch: vi.fn() } }))
vi.mock('../../features/ui', () => ({ uiActions: { errorNoticeRaised: (x: unknown) => x, errorNoticeDismissed: (x: unknown) => x } }))
import { ManagedAuthProvider } from './managed'
const snapshot = (slot: string) => ({ slot, status: 'ready', sessionId: 's', version: 1, userId: 'u', email: 'u@example.com', expiresAt: 9999999999999 })
beforeEach(() => {
  const state = { app: snapshot('app'), codex: snapshot('codex'), user: { id: 'u' } }
  vi.stubGlobal('localStorage', { getItem: () => null, removeItem: vi.fn() })
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail: unknown) {} })
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), electronAPI: { auth: { migrate: vi.fn(async () => state), status: vi.fn(async () => state), onChanged: vi.fn(), check: vi.fn(async () => state) } } })
})
describe('token-free renderer auth facade', () => {
  it('projects identity without tokens and never reads generic Electron storage', async () => {
    const provider = new ManagedAuthProvider()
    await provider.initialize()
    expect(await provider.getSession()).toMatchObject({ userId: 'u', session: null, accessToken: null })
    expect(provider.requiresNetworkAuth()).toBe(false)
  })
})
