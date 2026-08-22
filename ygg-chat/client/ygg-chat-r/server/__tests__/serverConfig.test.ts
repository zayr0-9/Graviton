import { describe, expect, it } from 'vitest'
import { isLoopbackHost, resolveYggServerConfig } from '../serverConfig.js'

const REQUIRED = {
  dataDir: '/tmp/ygg-test-data',
  tempDir: '/tmp/ygg-test-temp',
  resourcesDir: '/tmp/ygg-test-resources',
}

describe('isLoopbackHost', () => {
  it('accepts loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.1.2.3', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  it('rejects non-loopback hosts', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', '']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('resolveYggServerConfig', () => {
  it('applies loopback and secure-tool-runtime defaults', () => {
    const config = resolveYggServerConfig({ ...REQUIRED })

    expect(config.bindHost).toBe('127.0.0.1')
    expect(config.preferredPort).toBe(3002)
    expect(config.cors.mode).toBe('loopback')
    expect(config.oauth.enabled).toBe(false)
    expect(config.oauth.callbackPort).toBe(1455)
    expect(config.toolRuntime.mode).toBe('utility')
    expect(config.toolRuntime.allowInProcessFallback).toBe(false)
    expect(config.dbPath.endsWith('local-sync.db')).toBe(true)
  })

  it('rejects a non-loopback bind host without the explicit override', () => {
    expect(() => resolveYggServerConfig({ ...REQUIRED, bindHost: '0.0.0.0' })).toThrow(/non-loopback/i)
  })

  it('allows a non-loopback bind host with the explicit override', () => {
    const config = resolveYggServerConfig({ ...REQUIRED, bindHost: '0.0.0.0', allowNonLoopbackBind: true })
    expect(config.bindHost).toBe('0.0.0.0')
  })

  it('rejects invalid ports', () => {
    expect(() => resolveYggServerConfig({ ...REQUIRED, preferredPort: 70000 })).toThrow(/preferred port/i)
    expect(() => resolveYggServerConfig({ ...REQUIRED, fallbackPorts: [3003, -1] })).toThrow(/fallback port at index 1/i)
  })

  it('rejects an empty allowlist in allowlist CORS mode', () => {
    expect(() => resolveYggServerConfig({ ...REQUIRED, cors: { mode: 'allowlist', allowedOrigins: [] } })).toThrow(
      /allowlist/i
    )
  })

  it('requires the data, temp, and resources directories', () => {
    expect(() => resolveYggServerConfig({ ...REQUIRED, dataDir: ' ' })).toThrow(/dataDir/)
    expect(() => resolveYggServerConfig({ ...REQUIRED, tempDir: '' as string })).toThrow(/tempDir/)
  })
})
