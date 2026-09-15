import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ generation: 0, sessionId: null as string | null, accept: vi.fn() }))
vi.mock('../../../auth/runtime.js', () => ({
  getAuthManager: () => ({ generation: () => auth.generation, snapshot: () => ({ slot: 'codex', status: auth.sessionId ? 'ready' : 'signed_out', sessionId: auth.sessionId, email: 'test@example.com' }) }),
  acceptCodexSession: (tokens: unknown) => { auth.accept(tokens); auth.generation++; auth.sessionId = 'new-session' },
}))
import { registerOpenAiOAuthRoutes, stopOpenAiOAuth } from '../../../routes/managedOAuthRoutes.js'
let server: Server
let base: string
const nativeFetch = globalThis.fetch
const post = (path: string, body: unknown) => nativeFetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(() => {
  auth.generation = 0; auth.sessionId = null; auth.accept.mockClear()
  const app = express(); app.use(express.json()); registerOpenAiOAuthRoutes(app)
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { vi.restoreAllMocks(); stopOpenAiOAuth(); await new Promise<void>(resolve => server.close(() => resolve())) })
describe('server-owned Codex login', () => {
  it('commits tokens only on server and returns a token-free completion snapshot', async () => {
    const start = await (await post('/api/openai/auth/start', {})).json() as any
    const access = `h.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')}.s`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: access, refresh_token: 'secret-refresh', expires_in: 3600 })))
    expect((await post('/api/openai/auth/exchange', { state: start.state, code: 'code' })).status).toBe(200)
    const result = await (await post('/api/openai/auth/complete', { state: start.state })).json() as any
    expect(result.success).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret-refresh')
    expect(JSON.stringify(result)).not.toContain('accessToken')
    expect(auth.accept).toHaveBeenCalledTimes(1)
    auth.sessionId = null; auth.generation++
    expect((await post('/api/openai/auth/complete', { state: start.state })).status).toBe(409)
  })
  it('rejects unknown callback state and removed raw refresh endpoint', async () => {
    expect((await post('/api/openai/auth/exchange', { state: 'unknown', code: 'code' })).status).toBe(400)
    expect((await post('/api/openai/auth/refresh', { refreshToken: 'secret' })).status).toBe(410)
    expect(auth.accept).not.toHaveBeenCalled()
  })
})
