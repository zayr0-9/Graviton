import { getPublicAuth } from '../../lib/auth/publicState'
import { loadProviderSettings } from '../../helpers/providerSettingsStorage'
export type { OpenAIUsageSnapshot, OpenAIUsageResult } from '../../../server/auth/codexUsage'
import type { OpenAIUsageResult } from '../../../server/auth/codexUsage'

export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api'
export const CHATGPT_CODEX_ENDPOINT = '/codex/responses'
/** Legacy non-Electron transport is unsupported; no raw credentials are exported. */
export async function getValidTokens(): Promise<{ accessToken: string; accountId: string } | null> {
  throw new Error('ChatGPT requires the server-owned Electron transport')
}
export function isOpenAIAuthenticated(): boolean {
  const status = getPublicAuth()?.codex.status
  return status === 'ready' || status === 'refreshing'
}
export function getOpenAIAccountEmail(): string | null { return getPublicAuth()?.codex.email ?? null }
export async function clearTokens(): Promise<void> { await window.electronAPI!.openaiChatGPT.clearTokens() }
export async function fetchOpenAIUsageStatus(): Promise<OpenAIUsageResult> {
  return window.electronAPI!.openaiChatGPT.usage() as Promise<OpenAIUsageResult>
}
const models = [
  ['gpt-5.6-sol', 'GPT-5.6 Sol', 'Flagship GPT-5.6 model for the most complex work'],
  ['gpt-6-astra', 'GPT-6-Astra', 'Our most capable model for complex, demanding work.'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 'Balanced GPT-5.6 model for everyday work'],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', 'Fast and cost-efficient GPT-5.6 model'],
  ['gpt-5.5', 'GPT-5.5', 'Latest GPT-5.5 frontier model for professional work'],
  ['gpt-5.5-pro', 'GPT-5.5 Pro', 'Version of GPT-5.5 that produces smarter and more precise responses'],
  ['gpt-5.3-codex', 'GPT-5.3 Codex', 'Latest GPT-5.3 Codex model for coding tasks'],
  ['gpt-4o', 'GPT-4o', 'GPT-4o multimodal model'],
]
export function getOpenAIChatGPTModels() {
  const contextLength = loadProviderSettings().openAiChatGptMaxContextTokens
  return models.map(([id, name, description]) => {
    const maxCompletionTokens = id === 'gpt-4o' || id === 'gpt-5.3-codex' ? 16384 : 128000
    return { id, name, displayName: name, description, version: 'chatgpt', contextLength, maxCompletionTokens,
      inputTokenLimit: contextLength, outputTokenLimit: maxCompletionTokens, promptCost: 0, completionCost: 0, requestCost: 0,
      thinking: true, supportsImages: true, supportsWebSearch: false, supportsStructuredOutputs: true,
      inputModalities: ['text', 'image'], outputModalities: ['text'], defaultTemperature: null, defaultTopP: null,
      defaultFrequencyPenalty: null, topProviderContextLength: null, isFreeTier: false }
  })
}
