import express from 'express'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderTokenStore } from '../../providers/tokenStore.js'
import { registerEphemeralGenerateRoutes } from '../ephemeralGenerateRoutes.js'

// Neutralize the Electron-session sync. It does `new Conf({ projectName: 'ygg-chat-r' })`,
// which reads the DEVELOPER'S REAL signed-in config and, when that session is near
// expiry, POSTs to Supabase to refresh it — then upserts the result into the very
// token store these tests preload.
//
// The `XDG_CONFIG_HOME` temp dir set in beforeEach was meant to isolate that, but
// `conf` resolves its path through `env-paths`, which on macOS returns
// `~/Library/Preferences/<name>` and ignores XDG_CONFIG_HOME entirely. So the
// isolation worked on Linux/CI and silently leaked on darwin. Mocking the one export
// isolates it on every platform. Everything else in the module stays real —
// normalizeAuthorizationToken is used by the route under test.
const authMocks = vi.hoisted(() => ({
  token: null as string | null,
  syncOpenRouterTokenFromElectronSession: vi.fn(async (_store: unknown) => {}),
}))

vi.mock('../../../auth/runtime.js', () => ({ getAuthManager: () => ({
  snapshot: () => ({ sessionId: 'test-session' }),
  resolve: async () => {
    await authMocks.syncOpenRouterTokenFromElectronSession(null)
    if (!authMocks.token) throw new Error('Sign in again to continue.')
    return { sessionId: 'test-session', revision: 0, accessToken: authMocks.token, userId: 'acct-route' }
  },
}) }))

describe('registerEphemeralGenerateRoutes', () => {
  let appServer: Server
  let baseUrl = ''
  let tokenStore: ProviderTokenStore
  let previousXdgConfigHome: string | undefined
  let tempConfigDir = ''

  beforeEach(async () => {
    authMocks.token = null
    authMocks.syncOpenRouterTokenFromElectronSession.mockReset()
    authMocks.syncOpenRouterTokenFromElectronSession.mockResolvedValue(undefined)
    previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    tempConfigDir = await mkdtemp(join(tmpdir(), 'ygg-ephemeral-routes-'))
    process.env.XDG_CONFIG_HOME = tempConfigDir
    delete process.env.OPENAI_CHATGPT_ACCESS_TOKEN
    delete process.env.OPENAI_ACCESS_TOKEN
    delete process.env.OPENAI_CHATGPT_ACCOUNT_ID
    delete process.env.YGG_APP_ACCESS_TOKEN
    delete process.env.YGG_ACCESS_TOKEN
    delete process.env.SUPABASE_ACCESS_TOKEN
    tokenStore = new ProviderTokenStore()
    const app = express()
    app.use(express.json())
    registerEphemeralGenerateRoutes(app, {
      tokenStore,
    })

    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    delete process.env.OPENAI_CHATGPT_ACCESS_TOKEN
    delete process.env.OPENAI_ACCESS_TOKEN
    delete process.env.OPENAI_CHATGPT_ACCOUNT_ID
    delete process.env.YGG_APP_ACCESS_TOKEN
    delete process.env.YGG_ACCESS_TOKEN
    delete process.env.SUPABASE_ACCESS_TOKEN
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    if (tempConfigDir) await rm(tempConfigDir, { recursive: true, force: true })
    vi.restoreAllMocks()
    await new Promise<void>((resolve, reject) => {
      appServer.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('direct provider responses endpoint fails fast without auth', async () => {
    const res = await fetch(`${baseUrl}/api/headless/provider/openai/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello', modelName: 'gpt-5.1-codex-mini', history: [] }),
    })

    expect(res.status).toBe(500)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('Sign in again to continue.')
  })

  it('ephemeral chat alias defaults to openai and fails fast without auth', async () => {
    const res = await fetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello', modelName: 'gpt-5.1-codex-mini', history: [] }),
    })

    expect(res.status).toBe(500)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('Sign in again to continue.')
  })

  it('ephemeral chat normalizes ChatGPT display labels and enables commentary fallback', async () => {
    authMocks.token = 'managed-token'
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1yb3V0ZSJ9fQ.sig'
    const nativeFetch = globalThis.fetch.bind(globalThis)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}'))
      expect(body.model).toBe('gpt-6.1-sol')
      const events = [
        {
          type: 'response.output_item.added',
          item: { id: 'msg-commentary', type: 'message', role: 'assistant', phase: 'commentary' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-commentary',
          delta: 'VISIBLE_TEXT_OK',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-commentary-route',
            output: [
              {
                id: 'msg-commentary',
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                content: [],
              },
            ],
          },
        },
      ]
      const bodyText = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
      return new Response(bodyText, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }) as any
    })

    const res = await nativeFetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello', modelName: 'GPT-6.1 Sol', history: [] }),
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(true)
    expect(payload.provider).toBe('openaichatgpt')
    expect(payload.message?.content).toBe('VISIBLE_TEXT_OK')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['explicit legacy openrouter', { provider: 'openrouter', modelName: 'openai/gpt-4o-mini' }],
    ['explicit openrouterbyok', { provider: 'openrouterbyok', modelName: 'openai/gpt-4o-mini' }],
    ['an unprefixed vendor/model slug', { modelName: 'anthropic/claude-3.5-sonnet' }],
  ])('ephemeral chat sends %s to the local OpenRouter BYOK provider, never a hosted backend', async (_label, request) => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    // Spy without a mock implementation: calls pass through, and every outbound URL is recorded.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await fetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello', history: [], ...request }),
    })

    expect(res.status).toBe(500)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('OpenRouter API key missing')
    const outbound = fetchSpy.mock.calls.map(call => String(call[0]))
    expect(outbound.some(url => url.includes('railway.app') || url.includes('/generate/ephemeral'))).toBe(false)
    vi.unstubAllEnvs()
  })

  it('ephemeral chat routes explicit bedrock requests through local bedrock handling', async () => {
    const res = await fetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'bedrock',
        content: 'hello',
        modelName: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        history: [],
      }),
    })

    expect(res.status).toBe(500)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('AWS Bedrock credentials missing')
  })
})
