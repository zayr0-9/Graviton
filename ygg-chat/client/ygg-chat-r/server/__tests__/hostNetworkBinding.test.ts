import { describe, expect, it } from 'vitest'
import {
  customBindingUnavailable, getRendererBindHost, parseHostNetworkBinding, readHostNetworkBinding, resolveHostNetworkBinding,
} from '../../electron/hostNetworkBinding.js'

const local = { mode: 'loopback' } as const
const all = { mode: 'all' } as const
const custom = { mode: 'custom', address: '192.168.1.20' } as const

describe('desktop network binding', () => {
  it('defaults to loopback for a new or invalid preference', () => {
    for (const raw of [undefined, null, false, { mode: 'anything' }, { mode: 'custom', address: '0.0.0.0' }]) {
      expect(resolveHostNetworkBinding(readHostNetworkBinding(raw), {}, []).bindHost).toBe('127.0.0.1')
    }
  })

  it('binds only to the explicit choice and maps the wildcard to loopback for the desktop client', () => {
    expect(resolveHostNetworkBinding(all, {}, []).bindHost).toBe('0.0.0.0')
    expect(getRendererBindHost('0.0.0.0')).toBe('127.0.0.1')
    expect(resolveHostNetworkBinding(custom, {}, [custom.address])).toMatchObject({ bindHost: custom.address, startupWarning: null })
    expect(getRendererBindHost(custom.address)).toBe(custom.address)
  })

  it('keeps a stale custom choice but uses loopback when the address is absent at launch', () => {
    expect(resolveHostNetworkBinding(custom, {}, ['192.168.1.30'])).toEqual({
      bindHost: '127.0.0.1', environmentOverride: false,
      startupWarning: '192.168.1.20 is not assigned to this computer. Graviton started in local-only mode instead.',
    })
    expect(customBindingUnavailable(custom, ['192.168.1.30'])).toContain('not assigned')
    expect(customBindingUnavailable(custom, [custom.address])).toBeNull()
  })

  it.each(['', '0.0.0.0', '127.0.0.2', '192.168.1.20:3002', 'http://10.0.0.1', '10.0.0.256', 'localhost', '::1', '224.0.0.1', '255.255.255.255'])('rejects invalid custom address %j', address => {
    expect(() => parseHostNetworkBinding({ mode: 'custom', address })).toThrow('LAN IPv4 address')
  })

  it('normalizes a custom address and accepts an assigned non-RFC1918 LAN/VPN address', () => {
    expect(parseHostNetworkBinding({ mode: 'custom', address: ' 100.90.10.9 ' })).toEqual({ mode: 'custom', address: '100.90.10.9' })
  })

  it('honors existing explicit launch overrides without implicitly opting in', () => {
    expect(resolveHostNetworkBinding(local, { allowRemote: '1' }, [])).toMatchObject({ bindHost: '0.0.0.0', environmentOverride: true })
    expect(resolveHostNetworkBinding(all, { allowRemote: 'false' }, [])).toMatchObject({ bindHost: '127.0.0.1', environmentOverride: true })
    expect(resolveHostNetworkBinding(all, { host: '127.0.0.2', allowRemote: 'yes' }, [])).toMatchObject({ bindHost: '127.0.0.2', environmentOverride: true })
    expect(resolveHostNetworkBinding(local, { allowRemote: '  ' }, []).environmentOverride).toBe(false)
    expect(getRendererBindHost('::')).toBe('[::1]')
  })
})
