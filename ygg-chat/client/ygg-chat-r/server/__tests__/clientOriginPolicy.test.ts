import { afterEach, expect, it } from 'vitest'
import { allowsClientUpgrade } from '../clientOriginPolicy.js'
import type { IncomingMessage } from 'node:http'
afterEach(() => { delete process.env.YGG_CLIENT_DEV_ORIGIN })
it('allows native and same-authority upgrades but rejects opaque/cross-site sockets', () => {
  const request = (origin?: string) => ({ headers: { host: 'host.local:4567', ...(origin ? { origin } : {}) } } as IncomingMessage)
  expect(allowsClientUpgrade(request())).toBe(true)
  expect(allowsClientUpgrade(request('file://'))).toBe(true)
  expect(allowsClientUpgrade(request('null'))).toBe(false)
  expect(allowsClientUpgrade(request('https://unrelated.example'))).toBe(false)
  expect(allowsClientUpgrade(request('https://host.local:4567'))).toBe(true)
  expect(allowsClientUpgrade(request('http://localhost:5173'))).toBe(false)
  process.env.YGG_CLIENT_DEV_ORIGIN = 'http://localhost:5173'
  expect(allowsClientUpgrade(request('http://localhost:5173'))).toBe(true)
})
