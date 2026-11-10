import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../auth/runtime.js', () => ({ getAuthManager: () => ({ resolve: async () => ({ accessToken: 'live-token' }) }) }))
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

  it('rejects raw OpenAI OAuth credential registration without creating a mirror', async () => {
    const response = await postJson(baseUrl, '/api/provider-auth/openai/token', { userId: 'u1', accessToken: 'secret', refreshToken: 'secret' })
    expect(response.status).toBe(410)
    expect(tokenStore.getLatest('openaichatgpt')).toBeNull()
  })

  it('has no hosted (Railway) OpenRouter token route', async () => {
    const response = await postJson(baseUrl, '/api/provider-auth/openrouter/token', { userId: 'u2', accessToken: 'secret' })
    expect(response.status).toBe(404)
    expect(tokenStore.getLatest('openrouter')).toBeNull()
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

  it('returns provider model listing', async () => {
    const res = await fetch(`${baseUrl}/api/provider-auth/models`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as any

    expect(payload.success).toBe(true)
    const providerNames = payload.providers.map((provider: any) => provider.name)
    expect(providerNames).toContain('openaichatgpt')
    expect(providerNames).toContain('openrouterbyok')
    expect(providerNames).not.toContain('openrouter')
    expect(providerNames).toContain('lmstudio')
    expect(providerNames).toContain('zai')
    expect(providerNames).toContain('bedrock')
    const openAiProvider = payload.providers.find((provider: any) => provider.name === 'openaichatgpt')
    expect(openAiProvider?.models).toEqual(['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.5'])
    const bedrockProvider = payload.providers.find((provider: any) => provider.name === 'bedrock')
    expect(bedrockProvider?.models).toContain('anthropic.claude-3-5-sonnet-20241022-v2:0')
  })
})
