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
  syncOpenRouterTokenFromElectronSession: vi.fn(async (_store: unknown) => {}),
}))

vi.mock('../../providers/electronAppAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../providers/electronAppAuth.js')>()),
  syncOpenRouterTokenFromElectronSession: authMocks.syncOpenRouterTokenFromElectronSession,
}))

describe('registerEphemeralGenerateRoutes', () => {
  let appServer: Server
  let baseUrl = ''
  let tokenStore: ProviderTokenStore
  let previousXdgConfigHome: string | undefined
  let tempConfigDir = ''

  beforeEach(async () => {
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
    expect(payload.error).toContain('OpenAI ChatGPT auth missing')
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
    expect(payload.error).toContain('OpenAI ChatGPT auth missing')
  })

  it('ephemeral chat normalizes ChatGPT display labels and enables commentary fallback', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1yb3V0ZSJ9fQ.sig'
    const nativeFetch = globalThis.fetch.bind(globalThis)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}'))
      expect(body.model).toBe('gpt-5.4-mini')
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
      body: JSON.stringify({ content: 'hello', modelName: 'GPT-5.4 Mini', history: [] }),
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(true)
    expect(payload.provider).toBe('openaichatgpt')
    expect(payload.message?.content).toBe('VISIBLE_TEXT_OK')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ephemeral chat routes explicit openrouter requests through openrouter handling', async () => {
    const res = await fetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        content: 'hello',
        modelName: 'openai/gpt-4o-mini',
        history: [],
      }),
    })

    expect(res.status).toBe(500)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('Graviton app auth token missing')
  })

  it('ephemeral chat infers openrouter from non-openai prefixed model names', async () => {
    const res = await fetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'hello',
        modelName: 'anthropic/claude-3.5-sonnet',
        history: [],
      }),
    })

    expect(res.status).toBe(500)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('Graviton app auth token missing')
  })

  it('awaits the electron-session sync before reading the token store', async () => {
    // resolveRemoteAppAccessToken runs syncOpenRouterTokenFromElectronSession to
    // refresh an expiring session INTO the token store, then reads that store on the
    // next line. The call used to be un-awaited, so the read always won the race and
    // the refreshed token could never be used. Asserting on the Authorization header
    // is what pins the ordering: a token that only exists after the sync resolves can
    // only appear here if the sync was awaited.
    let seenAuthorization: string | null = null
    authMocks.syncOpenRouterTokenFromElectronSession.mockImplementationOnce(async (store: any) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      store.upsert({ provider: 'openrouter', userId: 'u-synced', accessToken: 'synced-token' })
    })

    const nativeFetch = globalThis.fetch.bind(globalThis)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const url = String(typeof input === 'string' ? input : (input?.url ?? input))
      if (url.includes('/generate/ephemeral')) {
        seenAuthorization = String(init?.headers?.Authorization ?? '')
        return new Response('data: {"text":"hi"}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }) as any
      }
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }) as any
    })

    const res = await nativeFetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        content: 'hello',
        modelName: 'anthropic/claude-3.5-sonnet',
        history: [],
      }),
    })

    expect(res.status).toBe(200)
    expect(authMocks.syncOpenRouterTokenFromElectronSession).toHaveBeenCalledTimes(1)
    expect(seenAuthorization).toBe('Bearer synced-token')
  })

  it('ephemeral openrouter requests can use preloaded token store auth without passing userId', async () => {
    tokenStore.upsert({
      provider: 'openrouter',
      userId: 'u-openrouter',
      accessToken: 'app-token',
    })

    const nativeFetch = globalThis.fetch.bind(globalThis)
    // Return a FRESH Response per call, dispatched by URL, rather than
    // `mockResolvedValue` — that hands back ONE Response instance whose body can only
    // be read once, so any second outbound call on this path fails with
    // "Invalid state: ReadableStream is locked" and the route 500s.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(typeof input === 'string' ? input : (input?.url ?? input))
      if (url.includes('/generate/ephemeral')) {
        return new Response('data: {"text":"hi"}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }) as any
      }
      // Anything else (the session refresh) fails closed, which is what this test
      // wants: the route must fall back to the token preloaded into the store above.
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }) as any
    })

    const res = await nativeFetch(`${baseUrl}/api/headless/ephemeral/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        content: 'hello',
        modelName: 'anthropic/claude-3.5-sonnet',
        history: [],
      }),
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(true)
    expect(payload.provider).toBe('openrouter')
    expect(payload.message?.content).toBe('hi')
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
