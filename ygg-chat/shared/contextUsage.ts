import { isClaudeProvider } from './claudeProvider.js'
import { normalizeCompactionThreshold } from './compaction.js'

/** Providers that report their own context usage. Others use the local token estimate. */
export type ContextUsageProvider = 'openai' | 'claude'

/** Running totals for the whole provider session, where the provider reports them (Claude). */
export interface ContextUsageSessionTotals {
  /** The provider's own estimate, not a bill. Subscription accounts are not charged per token. */
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/**
 * One context snapshot: the last model call a provider reported. Snapshots replace one another;
 * they are not cumulative. `inputTokens` is the whole prompt, cached part included.
 */
export interface ContextUsage {
  provider: ContextUsageProvider
  model?: string
  responseId?: string
  inputTokens: number
  /** Prompt tokens read from the provider's cache. */
  cachedInputTokens: number
  /** Prompt tokens written to the cache (Claude only). */
  cacheCreationInputTokens?: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  /** Tokens the context holds after this call: what the meter shows. */
  usedTokens: number
  /** The model's context window, where the provider reports it (Claude). */
  contextWindow?: number
  /** Totals for the provider session so far (Claude). */
  session?: ContextUsageSessionTotals
  recordedAt: string
}

/** Persisted block types holding a ContextUsage. `openai_context_usage` is the legacy name. */
const CONTEXT_USAGE_BLOCK_TYPES = new Set(['context_usage', 'openai_context_usage'])

export function isContextUsageBlock(block: unknown): boolean {
  return !!block && typeof block === 'object' && CONTEXT_USAGE_BLOCK_TYPES.has((block as { type?: unknown }).type as string)
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
): ContextUsage | null {
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

const positiveOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/** The SDK's per-model totals (`result.modelUsage`), as far as this module reads them. */
export interface ClaudeModelUsageTotals {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUSD?: number
  contextWindow?: number
  canonicalModel?: string
}

/** The `modelUsage` entry for `model`: by key, by canonical id, or by key without a `[1m]`-style suffix. */
function claudeModelEntry(modelUsage: Record<string, ClaudeModelUsageTotals> | undefined, model: string | undefined) {
  if (!modelUsage || !model) return undefined
  const entries = Object.entries(modelUsage)
  const base = (name: string) => name.replace(/\[[^\]]*\]$/, '').toLowerCase()
  return modelUsage[model]
    ?? entries.find(([, entry]) => entry?.canonicalModel === model)?.[1]
    ?? entries.find(([name]) => base(name) === base(model))?.[1]
}

/**
 * A Claude run's context snapshot. `usage` is the last main-agent API call (Messages API usage, whose
 * `input_tokens` excludes cache reads and writes); `modelUsage` and `totalCostUsd` come from the
 * SDK `result` and are running totals for the session's query, subagents and compaction included.
 */
export function claudeContextUsage(params: {
  usage: unknown
  model?: string
  responseId?: string
  modelUsage?: Record<string, ClaudeModelUsageTotals>
  totalCostUsd?: number
  recordedAt?: string
}): ContextUsage | null {
  const usage = params.usage && typeof params.usage === 'object' && !Array.isArray(params.usage) ? params.usage as Record<string, unknown> : null
  if (!usage) return null
  const uncached = finiteNonNegative(usage.input_tokens)
  const cacheRead = finiteNonNegative(usage.cache_read_input_tokens)
  const cacheWrite = finiteNonNegative(usage.cache_creation_input_tokens)
  const outputTokens = finiteNonNegative(usage.output_tokens)
  const inputTokens = uncached + cacheRead + cacheWrite
  if (inputTokens + outputTokens <= 0) return null
  const models = Object.values(params.modelUsage ?? {}).filter(entry => entry && typeof entry === 'object')
  const contextWindow = positiveOrUndefined(claudeModelEntry(params.modelUsage, params.model)?.contextWindow)
  const sum = (key: keyof ClaudeModelUsageTotals) => models.reduce((total, entry) => total + finiteNonNegative(entry[key]), 0)
  return {
    provider: 'claude',
    ...(params.model ? { model: params.model } : {}),
    ...(params.responseId ? { responseId: params.responseId } : {}),
    inputTokens,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    usedTokens: inputTokens + outputTokens,
    ...(contextWindow ? { contextWindow } : {}),
    ...(models.length ? { session: {
      costUsd: typeof params.totalCostUsd === 'number' ? finiteNonNegative(params.totalCostUsd) : sum('costUSD'),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadInputTokens: sum('cacheReadInputTokens'),
      cacheCreationInputTokens: sum('cacheCreationInputTokens'),
    } } : {}),
    recordedAt: params.recordedAt || new Date().toISOString(),
  }
}

/** A stored Claude snapshot, checked field by field. */
function normalizeStoredClaudeUsage(usage: Record<string, any>): ContextUsage | null {
  const inputTokens = finiteNonNegative(usage.inputTokens)
  const outputTokens = finiteNonNegative(usage.outputTokens)
  if (inputTokens + outputTokens <= 0) return null
  const session = usage.session && typeof usage.session === 'object' ? usage.session : null
  const contextWindow = positiveOrUndefined(usage.contextWindow)
  return {
    provider: 'claude',
    ...(typeof usage.model === 'string' ? { model: usage.model } : {}),
    ...(typeof usage.responseId === 'string' ? { responseId: usage.responseId } : {}),
    inputTokens,
    cachedInputTokens: Math.min(finiteNonNegative(usage.cachedInputTokens), inputTokens),
    cacheCreationInputTokens: finiteNonNegative(usage.cacheCreationInputTokens),
    outputTokens,
    reasoningTokens: finiteNonNegative(usage.reasoningTokens),
    totalTokens: finiteNonNegative(usage.totalTokens) || inputTokens + outputTokens,
    usedTokens: finiteNonNegative(usage.usedTokens) || inputTokens + outputTokens,
    ...(contextWindow ? { contextWindow } : {}),
    ...(session ? { session: {
      costUsd: finiteNonNegative(session.costUsd),
      inputTokens: finiteNonNegative(session.inputTokens),
      outputTokens: finiteNonNegative(session.outputTokens),
      cacheReadInputTokens: finiteNonNegative(session.cacheReadInputTokens),
      cacheCreationInputTokens: finiteNonNegative(session.cacheCreationInputTokens),
    } } : {}),
    recordedAt: typeof usage.recordedAt === 'string' ? usage.recordedAt : new Date(0).toISOString(),
  }
}

/** A message's `context_usage` field, when it holds a valid snapshot. */
export function normalizeStoredContextUsage(value: unknown): ContextUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, any>
  if (usage.provider === 'claude') return normalizeStoredClaudeUsage(usage)
  return normalizeOpenAIContextUsage(usage, {
    model: typeof usage.model === 'string' ? usage.model : undefined,
    responseId: typeof usage.responseId === 'string' ? usage.responseId : undefined,
    recordedAt: typeof usage.recordedAt === 'string' ? usage.recordedAt : undefined,
  })
}

export function isOpenAIProvider(providerName: unknown): boolean {
  if (typeof providerName !== 'string') return false
  const normalized = providerName.trim().toLowerCase().replace(/\s+/g, '')
  return normalized === 'openai' || normalized === 'openaichatgpt' || normalized === 'openai(chatgpt)'
}

/** Which reported-usage family a provider route belongs to, or null when the meter must estimate. */
export function contextUsageProviderFor(providerName: unknown): ContextUsageProvider | null {
  if (isOpenAIProvider(providerName)) return 'openai'
  return isClaudeProvider(providerName) ? 'claude' : null
}

export function effectiveContextTokens(reported: ContextUsage | null | undefined, estimated: number): number {
  return reported?.usedTokens ?? finiteNonNegative(estimated)
}

export function shouldCompactAtPercent(usedTokens: number, contextLength: number, thresholdPercent = 85): boolean {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(contextLength) || contextLength <= 0) return false
  return Math.max(0, usedTokens) * 100 >= contextLength * thresholdPercent
}

export function extractContextUsageFromBlocks(blocks: unknown): ContextUsage | null {
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
    if (!isContextUsageBlock(block)) continue
    const usage = block.usage ?? block
    if (usage?.provider === 'claude') {
      const normalized = normalizeStoredClaudeUsage(usage)
      if (normalized) return normalized
      continue
    }
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

export function contextUsageBlock(usage: ContextUsage): Record<string, unknown> {
  return { type: 'context_usage', usage }
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
  reportedUsage?: ContextUsage | null
  projectedTokens: number
  contextLength: number
  enabled?: boolean
  thresholdPercent?: number
}): ContinuationCompactionDecision {
  const reportedTokens = finiteNonNegative(params.reportedUsage?.usedTokens)
  const projectedTokens = finiteNonNegative(params.projectedTokens)
  const contextLength = finiteNonNegative(params.contextLength)
  const thresholdPercent = normalizeCompactionThreshold(params.thresholdPercent)
  const effectiveTokens = Math.max(reportedTokens, projectedTokens)

  return {
    shouldCompact:
      params.enabled !== false &&
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
