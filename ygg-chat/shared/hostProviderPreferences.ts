export interface HostProviderPreferences {
  defaultProvider: string | null
  openRouterTemperature: number | null
  compactionProvider: string | null
  compactionModel: string | null
  compactionSystemPrompt: string
  compactionThresholdPercent: number
  lmStudioBaseUrl: string | null
  openAiChatGptMaxContextTokens: number
  openAiPromptCacheRetention: 'in_memory' | '24h'
}
export const DEFAULT_HOST_PROVIDER_PREFERENCES: HostProviderPreferences = {
  defaultProvider: null, openRouterTemperature: null, compactionProvider: null, compactionModel: null,
  compactionSystemPrompt: 'You compact chat history. Return detailed markdown that preserves goals, hard requirements, key facts, decisions, pending tasks, and unresolved questions. Do not include tool protocol chatter, but include general context around changes made instead. Include full absolute paths of files touched/edited, and brief summary of what changed.',
  compactionThresholdPercent: 85, lmStudioBaseUrl: null, openAiChatGptMaxContextTokens: 258000, openAiPromptCacheRetention: 'in_memory',
}
export function validateHostProviderPreferences(raw: unknown): HostProviderPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid provider preferences')
  const value = { ...DEFAULT_HOST_PROVIDER_PREFERENCES, ...raw } as HostProviderPreferences
  if (Object.keys(raw).some(key => !(key in DEFAULT_HOST_PROVIDER_PREFERENCES))) throw new Error('Unknown provider preference')
  for (const key of ['defaultProvider', 'compactionProvider', 'compactionModel', 'lmStudioBaseUrl'] as const)
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key]!.length > 2048)) throw new Error(`Invalid ${key}`)
  if (typeof value.compactionSystemPrompt !== 'string' || value.compactionSystemPrompt.length > 200000) throw new Error('Invalid compaction prompt')
  for (const [key, min, max] of [['openRouterTemperature', 0, 2], ['compactionThresholdPercent', 1, 95], ['openAiChatGptMaxContextTokens', 1000, 2000000]] as const) {
    if (key === 'openRouterTemperature' && value[key] === null) continue
    const number = value[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw new Error(`Invalid ${key}`)
  }
  if (!['in_memory', '24h'].includes(value.openAiPromptCacheRetention)) throw new Error('Invalid cache retention')
  if (value.lmStudioBaseUrl) {
    const url = new URL(value.lmStudioBaseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid LM Studio URL')
  }
  return value
}
