import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS,
  loadProviderSettings,
  MAX_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS,
  MIN_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS,
  normalizeOpenAiChatGptMaxContextTokens,
  resolveProviderContextLength,
} from './providerSettingsStorage'

const installLocalStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  })
  return store
}

describe('ChatGPT max context provider setting', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the backward-compatible default when older settings omit the field', () => {
    const store = installLocalStorage()
    store.set('ygg_provider_settings', JSON.stringify({ showProviderSelector: true }))

    expect(loadProviderSettings().openAiChatGptMaxContextTokens).toBe(DEFAULT_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS)
  })

  it('normalizes the setting to a bounded positive integer', () => {
    expect(normalizeOpenAiChatGptMaxContextTokens(64_000.9)).toBe(64_000)
    expect(normalizeOpenAiChatGptMaxContextTokens(100)).toBe(MIN_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS)
    expect(normalizeOpenAiChatGptMaxContextTokens(9_999_999)).toBe(MAX_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS)
    expect(normalizeOpenAiChatGptMaxContextTokens(Number.NaN)).toBe(DEFAULT_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS)
  })

  it('overrides every ChatGPT alias but leaves other provider limits unchanged', () => {
    const settings = { ...loadProviderSettings(), openAiChatGptMaxContextTokens: 96_000 }

    expect(resolveProviderContextLength('OpenAI (ChatGPT)', 258_000, settings)).toBe(96_000)
    expect(resolveProviderContextLength('openaichatgpt', undefined, settings)).toBe(96_000)
    expect(resolveProviderContextLength('openai', 128_000, settings)).toBe(96_000)
    expect(resolveProviderContextLength('OpenRouter', 200_000, settings)).toBe(200_000)
    expect(resolveProviderContextLength('LM Studio', 32_000, settings)).toBe(32_000)
  })
})
