import { describe, it, expect, vi } from 'vitest'
import { AuthSessionManager, AuthFailure, type Credential, type CredentialStore } from '../../../auth/authSessionManager.js'
import type { AuthSlot } from '../../../../../../shared/auth.js'

function setup() {
  let now = 1_000_000
  const data = new Map<AuthSlot, Credential>()
  const initialized = new Set<AuthSlot>()
  const store: CredentialStore = { read: slot => data.get(slot) ?? null, isInitialized: slot => initialized.has(slot), write: (slot, value) => { initialized.add(slot); if (value) data.set(slot, value); else data.delete(slot) } }
  const refresh = vi.fn(async (_slot: AuthSlot, value: Credential) => ({ ...value, accessToken: 'new', refreshToken: 'rotated', expiresAt: now + 3_600_000 }))
  const manager = new AuthSessionManager(store, refresh, () => now)
  manager.replace('app', { userId: 'user', accessToken: 'old', refreshToken: 'refresh', expiresAt: now - 1 })
  return { manager, refresh, store, data, advance: (ms: number) => { now += ms } }
}
describe('single-owner authentication lifecycle', () => {
  it('coalesces refresh and persists the rotation before returning', async () => {
    const { manager, refresh, store } = setup()
    const values = await Promise.all(Array.from({ length: 20 }, () => manager.resolve('app')))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(values.every(value => value.accessToken === 'new')).toBe(true)
    expect(store.read('app')?.refreshToken).toBe('rotated')
    expect(manager.snapshot('app').status).toBe('ready')
  })
  it('uses a newer revision instead of rotating again for simultaneous rejected requests', async () => {
    const { manager, refresh } = setup()
    await manager.resolve('app')
    await manager.resolve('app', { rejectedRevision: 0 })
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('does not erase credentials or return an expired token on temporary failure', async () => {
    const { manager, refresh, store } = setup()
    refresh.mockRejectedValue(new Error('offline'))
    await expect(manager.resolve('app')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    expect(store.read('app')?.refreshToken).toBe('refresh')
    await expect(manager.resolve('app')).rejects.toMatchObject({ category: 'temporarily_unavailable' })
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('fences a refresh that completes after logout', async () => {
    const { manager, refresh, store } = setup()
    let finish!: (value: any) => void
    refresh.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = manager.resolve('app')
    await Promise.resolve()
    manager.replace('app', null)
    finish({ userId: 'user', accessToken: 'late', refreshToken: 'late', expiresAt: 9_000_000 })
    await expect(pending).rejects.toMatchObject({ category: 'reauth_required' })
    expect(store.read('app')).toBeNull()
    expect(manager.snapshot('app').status).toBe('signed_out')
  })
  it('never adopts a different account on refresh', async () => {
    const { manager, refresh, store } = setup()
    refresh.mockResolvedValue({ ...store.read('app')!, userId: 'other', expiresAt: 9_000_000 })
    await expect(manager.resolve('app')).rejects.toMatchObject({ category: 'reauth_required' })
    expect(store.read('app')?.userId).toBe('user')
  })
  it('stops retrying terminal invalid grants and publishes token-free status', async () => {
    const { manager, refresh } = setup()
    const events: unknown[] = []
    manager.subscribe(value => events.push(value))
    refresh.mockRejectedValue(new AuthFailure('app', 'reauth_required', 'Reconnect'))
    await expect(manager.resolve('app')).rejects.toThrow('Reconnect')
    await expect(manager.resolve('app')).rejects.toThrow('Reconnect')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(events)).not.toContain('accessToken')
    expect(JSON.stringify(events)).not.toContain('refreshToken')
  })
  it('does not report a failed durable commit as a successful refresh', async () => {
    const { manager, store } = setup()
    store.write = () => { throw new Error('disk full') }
    await expect(manager.resolve('app')).rejects.toMatchObject({ category: 'configuration_error' })
  })
  it('rejects old run references after account replacement', async () => {
    const { manager } = setup()
    const sessionId = manager.snapshot('app').sessionId!
    manager.replace('app', { userId: 'other', accessToken: 'other', refreshToken: 'other', expiresAt: 9_000_000 })
    await expect(manager.resolve('app', { sessionId })).rejects.toMatchObject({ category: 'reauth_required' })
  })
})

describe('auth completion interleavings', () => {
  it('does not deliver credentials if a completion subscriber logs out', async () => {
    const { manager } = setup()
    manager.subscribe(snapshot => { if (snapshot.status === 'ready') manager.replace('app', null) })
    await expect(manager.resolve('app')).rejects.toMatchObject({ category: 'reauth_required' })
  })
  it('does not return a pre-logout token when logout persistence fails during a temporary refresh failure', async () => {
    const { manager, refresh, store } = setup()
    store.write('app', { ...store.read('app')!, acquiredAt: 0, expiresAt: 1_100_000 })
    let fail!: (error: Error) => void
    refresh.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    const pending = manager.resolve('app')
    await Promise.resolve()
    store.write = () => { throw new Error('disk full') }
    expect(() => manager.replace('app', null)).toThrow('Could not save')
    fail(new Error('offline'))
    await expect(pending).rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })
  it('does not commit after stop even when an adapter ignores abort', async () => {
    const { manager, refresh, store } = setup()
    let finish!: (value: any) => void
    refresh.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = manager.resolve('app')
    await Promise.resolve()
    manager.stop()
    finish({ ...store.read('app')!, accessToken: 'late', expiresAt: 9_000_000 })
    await expect(pending).rejects.toBeDefined()
    expect(store.read('app')?.accessToken).toBe('old')
  })
})
