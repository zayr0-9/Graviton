export interface OpenAIContextUsage {
  provider: 'openai'
  model?: string
  responseId?: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  usedTokens: number
  recordedAt: string
}

const finiteNonNegative = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const firstNumber = (...values: unknown[]): number => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return 0
}

export function normalizeOpenAIContextUsage(
  value: unknown,
  metadata: { model?: string; responseId?: string; recordedAt?: string } = {}
): OpenAIContextUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, any>
  const inputTokens = firstNumber(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
  const outputTokens = firstNumber(
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.completionTokens
  )
  const totalTokens = firstNumber(usage.total_tokens, usage.totalTokens)
  const cachedInputTokens = firstNumber(
    usage.input_tokens_details?.cached_tokens,
    usage.inputTokensDetails?.cachedTokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.promptTokensDetails?.cachedTokens,
    usage.cachedInputTokens
  )
  const reasoningTokens = firstNumber(
    usage.output_tokens_details?.reasoning_tokens,
    usage.outputTokensDetails?.reasoningTokens,
    usage.reasoningTokens
  )
  const usedTokens = inputTokens + outputTokens || totalTokens

  if (usedTokens <= 0 && inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return null

  return {
    provider: 'openai',
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.responseId ? { responseId: metadata.responseId } : {}),
    inputTokens,
    cachedInputTokens: Math.min(finiteNonNegative(cachedInputTokens), inputTokens || cachedInputTokens),
    outputTokens,
    reasoningTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    usedTokens,
    recordedAt: metadata.recordedAt || new Date().toISOString(),
  }
}

export function isOpenAIProvider(providerName: unknown): boolean {
  if (typeof providerName !== 'string') return false
  const normalized = providerName.trim().toLowerCase().replace(/\s+/g, '')
  return normalized === 'openai' || normalized === 'openaichatgpt' || normalized === 'openai(chatgpt)'
}

export function effectiveOpenAIContextTokens(reported: OpenAIContextUsage | null | undefined, estimated: number): number {
  return reported?.usedTokens ?? finiteNonNegative(estimated)
}

export function shouldCompactAtPercent(usedTokens: number, contextLength: number, thresholdPercent = 85): boolean {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextLength) || contextLength <= 0) return false
  return Math.max(0, usedTokens) * 100 >= contextLength * thresholdPercent
}

export function extractOpenAIContextUsageFromBlocks(blocks: unknown): OpenAIContextUsage | null {
  let parsed = blocks
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  for (let index = parsed.length - 1; index >= 0; index--) {
    const block = parsed[index]
    if (block?.type !== 'openai_context_usage') continue
    const usage = block.usage ?? block
    const normalized = normalizeOpenAIContextUsage(usage, {
      model: typeof block.model === 'string' ? block.model : typeof usage?.model === 'string' ? usage.model : undefined,
      responseId:
        typeof block.responseId === 'string' ? block.responseId : typeof usage?.responseId === 'string' ? usage.responseId : undefined,
      recordedAt:
        typeof block.recordedAt === 'string' ? block.recordedAt : typeof usage?.recordedAt === 'string' ? usage.recordedAt : undefined,
    })
    if (normalized) return normalized
  }
  return null
}

export function openAIContextUsageBlock(usage: OpenAIContextUsage): Record<string, unknown> {
  return { type: 'openai_context_usage', usage }
}

export interface ContinuationCompactionDecision {
  shouldCompact: boolean
  reportedTokens: number
  projectedTokens: number
  effectiveTokens: number
  contextLength: number
  thresholdPercent: number
}

export function resolveOpenAIContinuationCompaction(params: {
  providerName: unknown
  reportedUsage?: OpenAIContextUsage | null
  projectedTokens: number
  contextLength: number
  enabled?: boolean
  thresholdPercent?: number
}): ContinuationCompactionDecision {
  const reportedTokens = finiteNonNegative(params.reportedUsage?.usedTokens)
  const projectedTokens = finiteNonNegative(params.projectedTokens)
  const contextLength = finiteNonNegative(params.contextLength)
  const thresholdPercent =
    typeof params.thresholdPercent === 'number' && Number.isFinite(params.thresholdPercent)
      ? Math.max(0, params.thresholdPercent)
      : 85
  const effectiveTokens = Math.max(reportedTokens, projectedTokens)

  return {
    shouldCompact:
      params.enabled !== false &&
      isOpenAIProvider(params.providerName) &&
      contextLength > 0 &&
      shouldCompactAtPercent(effectiveTokens, contextLength, thresholdPercent),
    reportedTokens,
    projectedTokens,
    effectiveTokens,
    contextLength,
    thresholdPercent,
  }
}

export function openAIModelContextLength(modelName: unknown): number {
  const normalized = typeof modelName === 'string' ? modelName.trim().toLowerCase() : ''
  if (normalized === 'gpt-4o' || normalized.startsWith('gpt-4o-')) return 128_000
  return 258_000
}
