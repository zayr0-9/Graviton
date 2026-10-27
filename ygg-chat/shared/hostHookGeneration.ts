export interface HostHookGeneration {
  provider: 'auto' | 'openaichatgpt' | 'claudecode'
  openAiModel: string
  claudeModel: string
}

export const DEFAULT_HOST_HOOK_GENERATION: HostHookGeneration = {
  provider: 'auto', openAiModel: 'gpt-6-luna', claudeModel: '',
}

export function validateHostHookGeneration(input: unknown): HostHookGeneration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid hook generation settings')
  const value = { ...DEFAULT_HOST_HOOK_GENERATION, ...input }
  if (Object.keys(value).some(key => !['provider', 'openAiModel', 'claudeModel'].includes(key)) ||
    !['auto', 'openaichatgpt', 'claudecode'].includes(value.provider)) throw new Error('Invalid hook generation provider')
  for (const key of ['openAiModel', 'claudeModel'] as const) {
    if (typeof value[key] !== 'string' || value[key].length > 200 || /[\s\x00-\x1f\x7f]/.test(value[key]) || value[key].startsWith('-')) throw new Error('Invalid hook generation model')
  }
  if (!value.openAiModel) throw new Error('OpenAI hook model is required')
  return value
}
