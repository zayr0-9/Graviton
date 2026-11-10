import { contextUsageAfterCompaction } from '../../../shared/compaction'
import { estimateTokenCount } from 'tokenx'
import {
  contextUsageProviderFor,
  effectiveContextTokens,
  extractContextUsageFromBlocks,
  normalizeStoredContextUsage,
  type ContextUsage,
  type ContextUsageProvider,
} from '../../../shared/contextUsage.js'

/** Minimal message shape shared by the renderer meter and server tool loop. */
export interface ContextMeterMessage {
  role?: string
  content?: unknown
  content_blocks?: unknown
  tool_calls?: unknown
  context_usage?: ContextUsage | string | null
  note?: string | null
}

const IMAGE_PAYLOAD_OMITTED_PLACEHOLDER = '[image payload omitted from token estimate]'

function parseMaybeJsonArray(value: unknown): any[] | null {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  if (typeof value === 'object') return [value]
  return null
}

function isImageDataUrl(value: unknown): boolean {
  return typeof value === 'string' && /^data:image\/[^;,]+;base64,/i.test(value)
}

function sanitizeImagePayloads(value: any): { value: any; changed: boolean } {
  let changed = false

  const sanitizeBlock = (block: any): any => {
    if (isImageDataUrl(block)) {
      changed = true
      return IMAGE_PAYLOAD_OMITTED_PLACEHOLDER
    }
    if (!block || typeof block !== 'object') return block
    if (Array.isArray(block)) return block.map(item => sanitizeBlock(item))

    const next: any = {}
    for (const [key, child] of Object.entries(block)) {
      if (key === 'result' && block.type === 'image_generation_call' && typeof child === 'string' && child.trim()) {
        next[key] = IMAGE_PAYLOAD_OMITTED_PLACEHOLDER
        changed = true
        continue
      }

      // Legacy tool results may contain a JSON string with nested image data URLs.
      if (typeof child === 'string' && (key === 'content' || key === 'output') && child.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(child)
          const sanitized = sanitizeBlock(parsed)
          next[key] = sanitized === parsed ? child : JSON.stringify(sanitized)
          continue
        } catch {
          // Keep malformed/non-JSON strings unchanged.
        }
      }

      next[key] = sanitizeBlock(child)
    }
    return next
  }

  return { value: sanitizeBlock(value), changed }
}

export function safeEstimateTokenCount(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') {
    return value.length > 0 ? estimateTokenCount(value) : 0
  }

  try {
    const serialized = JSON.stringify(value)
    return serialized ? estimateTokenCount(serialized) : 0
  } catch {
    return 0
  }
}

export function estimateContentBlocksForContext(blocks: unknown): number {
  const parsedBlocks = parseMaybeJsonArray(blocks)
  if (!parsedBlocks) return safeEstimateTokenCount(blocks)

  const sanitized = sanitizeImagePayloads(parsedBlocks)
  if (!sanitized.changed) {
    // Preserve the previous behavior exactly for chats with no image payloads.
    return safeEstimateTokenCount(blocks)
  }

  return safeEstimateTokenCount(sanitized.value)
}

/** The snapshot an assistant row carries, in its `context_usage` field or a usage block. */
function messageContextUsage(message: ContextMeterMessage): ContextUsage | null {
  return normalizeStoredContextUsage(message.context_usage) ?? extractContextUsageFromBlocks(message.content_blocks)
}

/** The newest reported snapshot, from `provider` only when given. */
export function latestContextUsage(
  messages: Array<ContextMeterMessage | null | undefined>,
  provider?: ContextUsageProvider
): ContextUsage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const usage = messageContextUsage(message)
    if (usage && (!provider || usage.provider === provider)) return usage
  }
  return null
}

export function resolveContextTokens(params: {
  providerName: unknown
  estimatedTokens: number
  messages: Array<ContextMeterMessage | null | undefined>
}): { effectiveTokens: number; reportedUsage: ContextUsage | null; source: 'reported' | 'estimated' } {
  const provider = contextUsageProviderFor(params.providerName)
  if (!provider) {
    return { effectiveTokens: Math.max(0, params.estimatedTokens), reportedUsage: null, source: 'estimated' }
  }

  const reportedUsage = latestContextUsage(params.messages, provider)
  return {
    effectiveTokens: effectiveContextTokens(reportedUsage, params.estimatedTokens),
    reportedUsage,
    source: reportedUsage ? 'reported' : 'estimated',
  }
}

/** Reported snapshots in branch order, without repeats; from `provider` only when given. */
export function contextUsageHistory(
  messages: Array<ContextMeterMessage | null | undefined>,
  provider?: ContextUsageProvider
): ContextUsage[] {
  const history: ContextUsage[] = []
  const seenSnapshots = new Set<string>()

  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue
    const usage = messageContextUsage(message)
    if (!usage || (provider && usage.provider !== provider)) continue

    const snapshotKey = usage.responseId || `${usage.recordedAt}:${usage.usedTokens}:${usage.cachedInputTokens}`
    if (seenSnapshots.has(snapshotKey)) continue
    seenSnapshots.add(snapshotKey)
    history.push(usage)
  }

  return history
}

/** Same approximate accounting as the context bar; callers supply only their branch. */
export function calculateBranchContextUsage(params: {
  providerName: unknown
  messages: Array<ContextMeterMessage | null | undefined>
  prompts?: unknown[]
}) {
  const contextMessages = contextUsageAfterCompaction(params.messages.filter(Boolean))
  const promptAndContextTokens = (params.prompts ?? []).reduce<number>(
    (total, prompt) => total + safeEstimateTokenCount(prompt), 0
  )
  const messageTokens = contextMessages.reduce((total, message) => {
    if (!message) return total
    // Legacy `tool_calls` repeats the blocks' tool calls; count it only for rows without `tool_use` blocks.
    const hasToolUseBlocks = parseMaybeJsonArray(message.content_blocks)?.some(block => block?.type === 'tool_use')
    const legacyToolCalls = hasToolUseBlocks ? 0 : safeEstimateTokenCount(message.tool_calls)
    return total + safeEstimateTokenCount(message.content) +
      estimateContentBlocksForContext(message.content_blocks) + legacyToolCalls
  }, 0)
  const estimatedContextTokens = promptAndContextTokens + messageTokens
  const resolved = resolveContextTokens({
    providerName: params.providerName,
    estimatedTokens: estimatedContextTokens,
    messages: contextMessages,
  })
  return {
    promptAndContextTokens,
    messageTokens,
    estimatedContextTokens,
    totalContextTokens: resolved.effectiveTokens,
    reportedUsage: resolved.reportedUsage,
    usageHistory: contextUsageHistory(contextMessages, contextUsageProviderFor(params.providerName) ?? undefined),
    source: resolved.source,
  }
}
