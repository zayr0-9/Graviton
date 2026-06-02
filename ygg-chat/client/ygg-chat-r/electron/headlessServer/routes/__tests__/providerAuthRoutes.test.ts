import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderTokenStore } from '../../providers/tokenStore.js'
import { registerProviderAuthRoutes } from '../providerAuthRoutes.js'

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function deleteRequest(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' })
}

describe('registerProviderAuthRoutes', () => {
  let appServer: Server
  let baseUrl = ''
  let tokenStore: ProviderTokenStore
  const originalFetch = global.fetch

  beforeEach(() => {
    tokenStore = new ProviderTokenStore()

    const app = express()
    app.use(express.json())
    registerProviderAuthRoutes(app, { tokenStore })

    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    global.fetch = originalFetch

    await new Promise<void>((resolve, reject) => {
      appServer.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('stores and clears openai token records', async () => {
    const putToken = await postJson(baseUrl, '/api/provider-auth/openai/token', {
      userId: 'u1',
      accessToken: 'token.without.jwt.claim',
      accountId: 'acct-1',
      refreshToken: 'ref-abc',
    })
    expect(putToken.status).toBe(200)

    const getToken = await fetch(`${baseUrl}/api/provider-auth/openai/token?userId=u1`)
    expect(getToken.status).toBe(200)
    const tokenPayload = (await getToken.json()) as any
    expect(tokenPayload.success).toBe(true)
    expect(tokenPayload.hasToken).toBe(true)
    expect(tokenPayload.token).toBeUndefined()

    expect(tokenStore.get('openaichatgpt', 'u1')?.accountId).toBe('acct-1')
    expect(tokenStore.get('openaichatgpt', 'u1')?.accessToken).toBe('token.without.jwt.claim')

    const delToken = await deleteRequest(baseUrl, '/api/provider-auth/openai/token?userId=u1')
    expect(delToken.status).toBe(200)
    expect(tokenStore.get('openaichatgpt', 'u1')).toBeNull()
  })

  it('stores and clears openrouter token records', async () => {
    const putToken = await postJson(baseUrl, '/api/provider-auth/openrouter/token', {
      userId: 'u2',
      accessToken: 'or-key',
    })
    expect(putToken.status).toBe(200)

    const getToken = await fetch(`${baseUrl}/api/provider-auth/openrouter/token?userId=u2`)
    expect(getToken.status).toBe(200)
    const tokenPayload = (await getToken.json()) as any
    expect(tokenPayload.success).toBe(true)
    expect(tokenPayload.hasToken).toBe(true)
    expect(tokenPayload.token).toBeUndefined()
    expect(tokenStore.get('openrouter', 'u2')?.accessToken).toBe('or-key')

    const delToken = await deleteRequest(baseUrl, '/api/provider-auth/openrouter/token?userId=u2')
    expect(delToken.status).toBe(200)
    expect(tokenStore.get('openrouter', 'u2')).toBeNull()
  })

  it('stores and clears bedrock credential records', async () => {
    const credentials = JSON.stringify({
      region: 'us-east-1',
      accessKeyId: 'akid',
      secretAccessKey: 'secret',
    })
    const putToken = await postJson(baseUrl, '/api/provider-auth/bedrock/token', {
      userId: 'u-bedrock',
      accessToken: credentials,
    })
    expect(putToken.status).toBe(200)

    const getToken = await fetch(`${baseUrl}/api/provider-auth/bedrock/token?userId=u-bedrock`)
    expect(getToken.status).toBe(200)
    const tokenPayload = (await getToken.json()) as any
    expect(tokenPayload.success).toBe(true)
    expect(tokenPayload.hasToken).toBe(true)
    expect(tokenPayload.token).toBeUndefined()
    expect(tokenStore.get('bedrock', 'u-bedrock')?.accessToken).toBe(credentials)

    const delToken = await deleteRequest(baseUrl, '/api/provider-auth/bedrock/token?userId=u-bedrock')
    expect(delToken.status).toBe(200)
    expect(tokenStore.get('bedrock', 'u-bedrock')).toBeNull()
  })

  it('fetches live openrouter model listing from remote when token is stored', async () => {
    tokenStore.upsert({
      provider: 'openrouter',
      userId: 'u-live',
      accessToken: 'Bearer live-token',
    })

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === 'https://webdrasil-production.up.railway.app/api/models/openrouter') {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer live-token',
        })
        return new Response(
          JSON.stringify({
            models: [
              'openai/gpt-5-mini',
              { name: 'anthropic/claude-3.7-sonnet' },
              { id: 'google/gemini-2.5-pro' },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      }
      return originalFetch(input, init)
    }) as typeof fetch

    const res = await fetch(`${baseUrl}/api/provider-auth/models?userId=u-live`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as any

    expect(payload.success).toBe(true)
    const openrouterProvider = payload.providers.find((provider: any) => provider.name === 'openrouter')
    expect(openrouterProvider?.models).toEqual([
      'openai/gpt-5-mini',
      'anthropic/claude-3.7-sonnet',
      'google/gemini-2.5-pro',
    ])
  })

  it('returns provider model listing', async () => {
    const res = await fetch(`${baseUrl}/api/provider-auth/models`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as any

    expect(payload.success).toBe(true)
    const providerNames = payload.providers.map((provider: any) => provider.name)
    expect(providerNames).toContain('openaichatgpt')
    expect(providerNames).toContain('openrouter')
    expect(providerNames).toContain('lmstudio')
    expect(providerNames).toContain('zai')
    expect(providerNames).toContain('bedrock')
    const bedrockProvider = payload.providers.find((provider: any) => provider.name === 'bedrock')
    expect(bedrockProvider?.models).toContain('anthropic.claude-3-5-sonnet-20241022-v2:0')
  })
})
