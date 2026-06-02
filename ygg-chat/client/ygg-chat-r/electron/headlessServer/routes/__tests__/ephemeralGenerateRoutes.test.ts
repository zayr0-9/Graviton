import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderTokenStore } from '../../providers/tokenStore.js'
import { registerEphemeralGenerateRoutes } from '../ephemeralGenerateRoutes.js'

describe('registerEphemeralGenerateRoutes', () => {
  let appServer: Server
  let baseUrl = ''
  let tokenStore: ProviderTokenStore

  beforeEach(() => {
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

  it('ephemeral openrouter requests can use preloaded token store auth without passing userId', async () => {
    tokenStore.upsert({
      provider: 'openrouter',
      userId: 'u-openrouter',
      accessToken: 'app-token',
    })

    const nativeFetch = globalThis.fetch.bind(globalThis)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: {"text":"hi"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }) as any
    )

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
