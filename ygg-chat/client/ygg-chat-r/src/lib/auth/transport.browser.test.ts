import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../platform/clientCapabilities', () => ({ isBrowserClient: true }))
import { hostAuthTransport } from './transport'

afterEach(() => vi.unstubAllGlobals())
describe('browser identity transport', () => {
  it('uses the host origin without preload or credential migration', async () => {
    const state = { app: {}, codex: {}, user: { id: 'host-user' } }
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => state }))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('window', {})
    const transport = hostAuthTransport()
    expect(await transport.status()).toEqual(state)
    expect(fetcher).toHaveBeenCalledWith('/api/host/auth/status', expect.objectContaining({ method: 'GET' }))
    expect(transport).not.toHaveProperty('migrate')
  })
  it('cleans up an independent public-state subscription', () => {
    const close = vi.fn()
    vi.stubGlobal('EventSource', class { close = close; onmessage = null })
    const unsubscribe = hostAuthTransport().onChanged(() => {})
    unsubscribe()
    expect(close).toHaveBeenCalledOnce()
  })
})
