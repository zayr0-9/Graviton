// Provider Settings Storage
// Simple localStorage-based persistence for provider visibility and default selection

import { getHostExecutionPreferences, getHostExecutionRevision, saveHostExecutionPreference } from '../services/hostExecutionClient'
import { normalizeCompactionThreshold } from '../../../../shared/compaction'
import { isCommunityMode } from '../config/runtimeMode'

const STORAGE_KEY = 'ygg_provider_settings'
export const PROVIDER_SETTINGS_CHANGE_EVENT = 'ygg-provider-settings-change'
export const MIN_OPENROUTER_TEMPERATURE = 0
export const MAX_OPENROUTER_TEMPERATURE = 2
export const DEFAULT_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = 258_000
export const MIN_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = 1_000
export const MAX_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = 2_000_000
export const DEFAULT_COMPACTION_SYSTEM_PROMPT =
  'You compact chat history. Return detailed markdown that preserves goals, hard requirements, key facts, decisions, pending tasks, and unresolved questions. Do not include tool protocol chatter, but include general context around changes made instead. Include full absolute paths of files touched/edited, and brief summary of what changed.'
export const DEFAULT_LMSTUDIO_BASE_URL = import.meta.env.VITE_LMSTUDIO_BASE || 'http://172.31.32.1:1234'

export type OpenAIPromptCacheRetention = 'in_memory' | '24h'

const HOST_PROVIDER_BASE_REVISION = Symbol('host-provider-base-revision')
export interface ProviderSettings {
  [HOST_PROVIDER_BASE_REVISION]?: number
  /** Whether the provider selector is visible in the chat UI */
  showProviderSelector: boolean
  /** Default provider to use when selector is hidden (provider name string) */
  defaultProvider: string | null
  /** Optional default temperature for OpenRouter generations. Null = provider/model default. */
  openRouterTemperature: number | null
  /** Preferred provider for automatic branch compaction. Null = use current chat provider. */
  compactionProvider: string | null
  /** Preferred model for automatic branch compaction. Null = use provider default/current model. */
  compactionModel: string | null
  /** System prompt used by auto-compaction summarization. */
  compactionSystemPrompt: string
  compactionThresholdPercent: number
  /** Optional LM Studio server base URL override. Null = use app default. */
  lmStudioBaseUrl: string | null
  /** Global context-window limit used by every OpenAI (ChatGPT) model and its auto-compaction threshold. */
  openAiChatGptMaxContextTokens: number
  /** OpenAI Responses API prompt cache retention policy. */
  openAiPromptCacheRetention: OpenAIPromptCacheRetention
}

const DEFAULT_SETTINGS: ProviderSettings = {
  showProviderSelector: true,
  defaultProvider: null,
  openRouterTemperature: null,
  compactionProvider: null,
  compactionModel: null,
  compactionSystemPrompt: DEFAULT_COMPACTION_SYSTEM_PROMPT,
  compactionThresholdPercent: 85,
  lmStudioBaseUrl: null,
  openAiChatGptMaxContextTokens: DEFAULT_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS,
  openAiPromptCacheRetention: 'in_memory',
}

const COMMUNITY_ALLOWED_PROVIDERS = new Set(['LM Studio', 'OpenAI (ChatGPT)', 'Z.AI / GLM'])
const COMMUNITY_FALLBACK_PROVIDER = 'LM Studio'

function normalizeOpenRouterTemperature(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const clamped = Math.max(MIN_OPENROUTER_TEMPERATURE, Math.min(MAX_OPENROUTER_TEMPERATURE, value))
  return Math.round(clamped * 100) / 100
}

function normalizeCompactionSystemPrompt(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_COMPACTION_SYSTEM_PROMPT
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_COMPACTION_SYSTEM_PROMPT
}

export function normalizeOpenAiChatGptMaxContextTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS
  }

  return Math.max(
    MIN_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS,
    Math.min(MAX_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS, Math.floor(value))
  )
}

export function isOpenAIChatGPTProviderName(providerName: unknown): boolean {
  if (typeof providerName !== 'string') return false
  const normalized = providerName.trim().toLowerCase().replace(/\s+/g, '')
  return normalized === 'openai' || normalized === 'openaichatgpt' || normalized === 'openai(chatgpt)'
}

export function resolveProviderContextLength(
  providerName: unknown,
  modelContextLength: number | null | undefined,
  settings: ProviderSettings = loadProviderSettings()
): number | undefined {
  if (isOpenAIChatGPTProviderName(providerName)) {
    return normalizeOpenAiChatGptMaxContextTokens(settings.openAiChatGptMaxContextTokens)
  }

  return typeof modelContextLength === 'number' && Number.isFinite(modelContextLength) && modelContextLength > 0
    ? modelContextLength
    : undefined
}

function normalizeOpenAiPromptCacheRetention(value: unknown): OpenAIPromptCacheRetention {
  return value === '24h' ? '24h' : 'in_memory'
}

export function normalizeLmStudioBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')
    const suffix = normalizedPath && normalizedPath !== '/' ? normalizedPath : ''
    return `${parsed.origin}${suffix}`
  } catch {
    return null
  }
}

export function resolveLmStudioBaseUrl(): string {
  return normalizeLmStudioBaseUrl(loadProviderSettings().lmStudioBaseUrl) || DEFAULT_LMSTUDIO_BASE_URL
}

function syncProviderSettingsToElectronStore(settings: ProviderSettings): void {
  if (typeof window === 'undefined') return
  if (import.meta.env.VITE_ENVIRONMENT !== 'electron') return

  const storageApi = window.electronAPI?.storage
  if (!storageApi?.set) return

  void storageApi.set(STORAGE_KEY, settings).catch(error => {
    console.error('Failed to mirror provider settings to Electron storage:', error)
  })
}

/**
 * Load provider settings from localStorage
 */
export function loadProviderSettings(): ProviderSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    const local = stored ? (JSON.parse(stored) as Partial<ProviderSettings>) : DEFAULT_SETTINGS
    const host = getHostExecutionPreferences()
    const parsed = host ? { ...host.provider, showProviderSelector: local.showProviderSelector } : local

    const resolvedDefaultProvider = parsed.defaultProvider ?? DEFAULT_SETTINGS.defaultProvider
    const communityDefaultProvider =
      resolvedDefaultProvider && COMMUNITY_ALLOWED_PROVIDERS.has(resolvedDefaultProvider)
        ? resolvedDefaultProvider
        : COMMUNITY_FALLBACK_PROVIDER

    return {
      ...(host ? { [HOST_PROVIDER_BASE_REVISION]: getHostExecutionRevision('provider') } : {}),
      showProviderSelector: isCommunityMode ? true : (parsed.showProviderSelector ?? DEFAULT_SETTINGS.showProviderSelector),
      defaultProvider: isCommunityMode ? communityDefaultProvider : resolvedDefaultProvider,
      openRouterTemperature: normalizeOpenRouterTemperature(parsed.openRouterTemperature),
      compactionProvider: parsed.compactionProvider ?? DEFAULT_SETTINGS.compactionProvider,
      compactionModel: parsed.compactionModel ?? DEFAULT_SETTINGS.compactionModel,
      compactionSystemPrompt: normalizeCompactionSystemPrompt(parsed.compactionSystemPrompt),
      compactionThresholdPercent: normalizeCompactionThreshold(parsed.compactionThresholdPercent),
      lmStudioBaseUrl: normalizeLmStudioBaseUrl(parsed.lmStudioBaseUrl),
      openAiChatGptMaxContextTokens: normalizeOpenAiChatGptMaxContextTokens(parsed.openAiChatGptMaxContextTokens),
      openAiPromptCacheRetention: normalizeOpenAiPromptCacheRetention(parsed.openAiPromptCacheRetention),
    }
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      defaultProvider: isCommunityMode ? COMMUNITY_FALLBACK_PROVIDER : DEFAULT_SETTINGS.defaultProvider,
    }
  }
}

/**
 * Save provider settings to localStorage and emit change event
 */
export async function saveProviderSettings(settings: ProviderSettings): Promise<void> {
  const normalized: ProviderSettings = {
    ...settings,
    openRouterTemperature: normalizeOpenRouterTemperature(settings.openRouterTemperature),
    compactionSystemPrompt: normalizeCompactionSystemPrompt(settings.compactionSystemPrompt),
    compactionThresholdPercent: normalizeCompactionThreshold(settings.compactionThresholdPercent),
    lmStudioBaseUrl: normalizeLmStudioBaseUrl(settings.lmStudioBaseUrl),
    openAiChatGptMaxContextTokens: normalizeOpenAiChatGptMaxContextTokens(settings.openAiChatGptMaxContextTokens),
    openAiPromptCacheRetention: normalizeOpenAiPromptCacheRetention(settings.openAiPromptCacheRetention),
  }

  if (getHostExecutionPreferences()) {
    const { showProviderSelector, [HOST_PROVIDER_BASE_REVISION]: revision, ...provider } = normalized
    if (!Number.isSafeInteger(revision)) throw new Error('Reload provider settings before saving; the edit base is missing.')
    const current = getHostExecutionPreferences()!.provider
    if ((Object.keys(current) as Array<keyof typeof current>).some(key => provider[key] !== current[key]))
      await saveHostExecutionPreference({ provider }, revision)
    normalized[HOST_PROVIDER_BASE_REVISION] = getHostExecutionRevision('provider')
    settings[HOST_PROVIDER_BASE_REVISION] = getHostExecutionRevision('provider')
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ showProviderSelector }))
    window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGE_EVENT, { detail: normalized }))
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    window.dispatchEvent(new CustomEvent(PROVIDER_SETTINGS_CHANGE_EVENT, { detail: normalized }))
    syncProviderSettingsToElectronStore(normalized)
  } catch (error) {
    console.error('Failed to save provider settings:', error)
  }
}

/**
 * Update a single setting and persist
 */
export async function updateProviderSetting<K extends keyof ProviderSettings>(
  key: K,
  value: ProviderSettings[K]
): Promise<ProviderSettings> {
  const current = loadProviderSettings()
  const updated = { ...current, [key]: value }
  await saveProviderSettings(updated)
  return updated
}
