import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { registerHostRuntimeRoutes } from '../routes/hostRuntimeRoutes.js'
import { getNativeClientFence, nativeClientHeader } from '../nativeClientFence.js'

const fixture = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  const snapshot = { status: 'ready', version: 1, userId: 'user', sessionId: 'session' }
  return { values, state: { app: snapshot, codex: snapshot, user: { id: 'user' } }, check: vi.fn(async () => {}), unsubscribe: vi.fn() }
})
vi.mock('../auth/runtime.js', () => ({
  publicAuthState: () => fixture.state,
  getAuthManager: () => ({ check: fixture.check, subscribe: () => fixture.unsubscribe }),
  enableLocalLogin: vi.fn(), disconnectAuth: vi.fn(),
}))
vi.mock('../auth/codexUsage.js', () => ({ fetchOpenAIUsageStatus: async () => ({ type: 'unauthenticated' }) }))
vi.mock('../headlessServer/config/settingsStore.js', () => ({ getSettingsStore: () => ({ get: (k: string) => fixture.values.get(k), set: (k: string, v: unknown) => fixture.values.set(k, v) }) }))
let server: Server | undefined
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) } })
async function start() {
  const app = express(); app.use(express.json()); registerHostRuntimeRoutes(app)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server!.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
describe('host public identity', () => {
  it('returns protocol/identity, no credential or migration endpoint', async () => {
    const origin = await start()
    const response = await fetch(`${origin}/api/host/runtime`)
    const data = await response.json()
    expect(data).toMatchObject({ protocol: 1, auth: { user: { id: 'user' } } })
    expect(data.epoch).toBeTypeOf('string')
    expect((await fetch(`${origin}/api/host/runtime`, { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })).status).toBe(200)
    expect((await fetch(`${origin}/api/host/auth/logout`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${origin}/api/host/auth/local`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(409)
    expect((await fetch(`${origin}/api/host/auth/logout`, { method: 'POST', headers: { origin: 'https://unrelated.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${origin}/api/host/auth/logout`, { method: 'POST', body: 'form' })).status).toBe(415)
    expect(JSON.stringify(data)).not.toMatch(/accessToken|refreshToken/)
    expect((await fetch(`${origin}/api/host/auth/migrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await fetch(`${origin}/api/host/auth/local`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'not-accepted' }) })).status).toBe(400)
  })
})

it('accepts fenced native cross-site fetches with absent/file/null Origin but rejects untrusted callers', async () => {
  const url = await start()
  for (const origin of [undefined, 'file://', 'null']) {
    const headers: Record<string, string> = { 'sec-fetch-site': 'cross-site', [nativeClientHeader]: getNativeClientFence() }
    if (origin) headers.origin = origin
    expect((await fetch(`${url}/api/host/runtime`, { headers })).status).toBe(200)
    expect((await fetch(`${url}/api/host/auth/local`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status).toBe(409) // Reached handler, not policy denial.
  }
  for (const fence of [undefined, 'forged']) {
    const headers: Record<string, string> = { 'sec-fetch-site': 'cross-site' }
    if (fence) headers[nativeClientHeader] = fence
    expect((await fetch(`${url}/api/host/runtime`, { headers })).status).toBe(403)
  }
})
