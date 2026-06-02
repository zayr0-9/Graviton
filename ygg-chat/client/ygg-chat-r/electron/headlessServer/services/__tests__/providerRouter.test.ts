import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiChatgptProvider } from '../../providers/openaiChatgptProvider.js'
import { ProviderRouter, normalizeProviderRoute } from '../providerRouter.js'

describe('provider routing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  it('normalizes openai provider aliases', () => {
    expect(normalizeProviderRoute('OpenAIChatGPT')).toBe('openaichatgpt')
    expect(normalizeProviderRoute('openai(chatgpt)')).toBe('openaichatgpt')
    expect(normalizeProviderRoute('openai')).toBe('openaichatgpt')
    expect(normalizeProviderRoute('z.ai')).toBe('zai')
    expect(normalizeProviderRoute('glm')).toBe('zai')
    expect(normalizeProviderRoute('bedrock')).toBe('bedrock')
    expect(normalizeProviderRoute('aws-bedrock')).toBe('bedrock')
    expect(normalizeProviderRoute('amazon bedrock')).toBe('bedrock')
    expect(normalizeProviderRoute('unknown-provider')).toBe('openaichatgpt')
  })

  it('routes openrouter and lmstudio through provider implementations', async () => {
    const router = new ProviderRouter()

    await expect(
      router.generate('openrouter', {
        modelName: 'openrouter/auto',
        history: [],
        userContent: 'hi',
        railwayTurn: {
          conversationId: 'c1',
        },
      })
    ).rejects.toThrow('Graviton app auth token missing')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'offline',
    } as any)

    await expect(
      router.generate('lmstudio', {
        modelName: 'local-model',
        history: [],
        userContent: 'hi',
      })
    ).rejects.toThrow('LM Studio request failed (503): offline')
  })

  it('routes zai through hyper-router provider and fails fast when auth is missing', async () => {
    const router = new ProviderRouter()

    await expect(
      router.generate('zai', {
        modelName: 'glm-5.1',
        history: [],
        userContent: 'hi',
      })
    ).rejects.toThrow('Z.AI API key missing')
  })

  it('routes bedrock through hyper-router provider and fails fast when auth is missing', async () => {
    const router = new ProviderRouter()

    await expect(
      router.generate('bedrock', {
        modelName: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        history: [],
        userContent: 'hi',
      })
    ).rejects.toThrow('AWS Bedrock credentials missing')
  })

  it('openai provider fails fast when auth is missing', async () => {
    const provider = new OpenAiChatgptProvider()

    await expect(
      provider.generate({
        modelName: 'gpt-5.2-codex',
        history: [],
        userContent: 'hello',
      })
    ).rejects.toThrow('OpenAI ChatGPT auth missing')
  })
})
