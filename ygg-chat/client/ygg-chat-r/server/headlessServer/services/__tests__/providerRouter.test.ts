import { afterEach, describe, expect, it, vi } from 'vitest'

// Never read the developer's persisted credentials or send real authenticated requests.
vi.mock('../../../auth/runtime.js', () => ({ getAuthManager: () => ({
  snapshot: () => ({ sessionId: null }),
  resolve: async () => { throw new Error('Sign in again to continue.') },
}) }))
import { OpenAiChatgptProvider } from '../../providers/openaiChatgptProvider.js'
import { ProviderRouter, UnknownProviderError, isKnownProviderName, normalizeProviderRoute, resolveProviderRoute } from '../providerRouter.js'

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
    // The retired hosted route is an alias for the user's own OpenRouter key.
    expect(normalizeProviderRoute('openrouter')).toBe('openrouterbyok')
    expect(normalizeProviderRoute('OpenRouter BYOK')).toBe('openrouterbyok')
  })

  it('resolves known names strictly and rejects unknown providers (Q7)', async () => {
    expect(resolveProviderRoute('OpenAI (ChatGPT)')).toBe('openaichatgpt')
    expect(resolveProviderRoute('Amazon Bedrock')).toBe('bedrock')
    expect(resolveProviderRoute('gemini')).toBeNull()
    expect(isKnownProviderName('Claude Code')).toBe(true)
    expect(isKnownProviderName('gemini')).toBe(false)
    await expect(new ProviderRouter().generate('gemini', { modelName: 'x', history: [], userContent: 'hi' })).rejects.toBeInstanceOf(
      UnknownProviderError
    )
  })

  it('applies the global context override only to ChatGPT routes', () => {
    process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = '123000'
    const router = new ProviderRouter()

    expect(router.resolveContextLength('OpenAI (ChatGPT)', 96_000)).toBe(96_000)
    expect(router.resolveContextLength('openaichatgpt', undefined)).toBe(123_000)
    expect(router.resolveContextLength('openrouterbyok', 200_000)).toBe(200_000)
    expect(router.resolveContextLength('lmstudio', 32_000)).toBe(32_000)
    delete process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS
  })

  it('routes legacy openrouter to BYOK and lmstudio through provider implementations', async () => {
    const router = new ProviderRouter()
    vi.stubEnv('OPENROUTER_API_KEY', '')

    await expect(
      router.generate('openrouter', {
        modelName: 'openrouter/auto',
        history: [],
        userContent: 'hi',
        turnContext: {
          conversationId: 'c1',
        },
      })
    ).rejects.toThrow('OpenRouter API key missing')
    vi.unstubAllEnvs()

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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))
    const provider = new OpenAiChatgptProvider()

    await expect(
      provider.generate({
        modelName: 'gpt-6.1-sol',
        history: [],
        userContent: 'hello',
      })
    ).rejects.toThrow('Sign in again to continue.')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
