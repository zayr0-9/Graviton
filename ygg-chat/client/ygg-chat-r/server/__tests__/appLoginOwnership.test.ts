import { beforeEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ generation: 1, accept: vi.fn() }))
vi.mock('../auth/runtime.js', () => ({
  getAuthManager: () => ({ generation: () => auth.generation }),
  acceptAppSession: (...args: unknown[]) => auth.accept(...args),
}))
vi.mock('../auth/refreshAdapters.js', () => ({ supabaseConfig: () => ({ url: 'https://identity.example' }) }))
import { cancelAppLogin, completeAppCallback, startAppLogin } from '../auth/appLogin.js'
const callback = (authorize: string) => new URL(authorize).searchParams.get('redirect_to')! + '#access_token=fixture&refresh_token=fixture'
describe('host login ownership', () => {
  beforeEach(() => { cancelAppLogin(); auth.generation = 1; auth.accept.mockReset() })
  it('reuses an owner attempt and rejects competing documents/providers', () => {
    const first = startAppLogin('google', false, 'a')
    expect(startAppLogin('google', false, 'a')).toBe(first)
    expect(() => startAppLogin('google', false, 'b')).toThrow('already in progress')
    expect(() => startAppLogin('github', false, 'a')).toThrow('already in progress')
    cancelAppLogin('b')
    expect(startAppLogin('google', false, 'a')).toBe(first)
    cancelAppLogin('a')
    expect(startAppLogin('github', false, 'b')).toContain('provider=github')
  })
  it('holds the reservation during async credential verification and fences cancellation', async () => {
    let finish!: () => void
    let valid!: () => boolean
    auth.accept.mockImplementation((_a, _r, check) => { valid = check; return new Promise<void>(resolve => { finish = resolve }) })
    const url = callback(startAppLogin('google', false, 'a'))
    const completing = completeAppCallback(url)
    expect(() => startAppLogin('google', false, 'a')).toThrow('already in progress')
    await expect(completeAppCallback(url)).rejects.toThrow('already in progress')
    cancelAppLogin('b'); expect(valid()).toBe(true)
    cancelAppLogin('a'); expect(valid()).toBe(false)
    startAppLogin('github', false, 'b')
    finish(); await completing
    expect(() => startAppLogin('google', false, 'a')).toThrow('already in progress')
  })
  it('lets the owner switch to manual code and rejects the old callback', async () => {
    const old = callback(startAppLogin('google', false, 'a'))
    expect(startAppLogin('google', true, 'a')).not.toContain('yggchat')
    await expect(completeAppCallback(old)).rejects.toThrow('Invalid login callback')
  })
})

it('deduplicates only the completed callback for the current account generation', async () => {
  cancelAppLogin()
  auth.accept.mockReset().mockResolvedValue({ user: { id: 'fixture' } })
  const url = callback(startAppLogin('google', false, 'a'))
  const first = await completeAppCallback(url)
  expect(await completeAppCallback(url)).toEqual(first)
  expect(auth.accept).toHaveBeenCalledTimes(1)
  auth.generation++
  await expect(completeAppCallback(url)).rejects.toThrow('Invalid login callback')
  cancelAppLogin()
})
