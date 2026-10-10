import { estimateTokenCount } from 'tokenx'
import {
  effectiveOpenAIContextTokens,
  extractOpenAIContextUsageFromBlocks,
  type OpenAIContextUsage,
} from '../../../shared/contextUsage.js'

/** Minimal message shape shared by the renderer meter and server tool loop. */
export interface ContextMeterMessage {
  role?: string
  content?: unknown
  content_blocks?: unknown
  tool_calls?: unknown
  context_usage?: OpenAIContextUsage | string | null
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

export function latestOpenAIContextUsage(messages: Array<ContextMeterMessage | null | undefined>): OpenAIContextUsage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const direct = message.context_usage
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && direct.provider === 'openai') {
      return direct as OpenAIContextUsage
    }
    const fromBlocks = extractOpenAIContextUsageFromBlocks(message.content_blocks)
    if (fromBlocks) return fromBlocks
  }
  return null
}

export function resolveContextTokens(params: {
  providerName: unknown
  estimatedTokens: number
  messages: Array<ContextMeterMessage | null | undefined>
}): { effectiveTokens: number; reportedUsage: OpenAIContextUsage | null; source: 'reported' | 'estimated' } {
  const providerName = typeof params.providerName === 'string' ? params.providerName.trim().toLowerCase().replace(/\s+/g, '') : ''
  const isOpenAI = providerName === 'openai' || providerName === 'openaichatgpt' || providerName === 'openai(chatgpt)'
  if (!isOpenAI) {
    return { effectiveTokens: Math.max(0, params.estimatedTokens), reportedUsage: null, source: 'estimated' }
  }

  const reportedUsage = latestOpenAIContextUsage(params.messages)
  return {
    effectiveTokens: effectiveOpenAIContextTokens(reportedUsage, params.estimatedTokens),
    reportedUsage,
    source: reportedUsage ? 'reported' : 'estimated',
  }
}

export function openAIContextUsageHistory(messages: Array<ContextMeterMessage | null | undefined>): OpenAIContextUsage[] {
  const history: OpenAIContextUsage[] = []
  const seenSnapshots = new Set<string>()

  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue
    const direct = message.context_usage
    const usage =
      direct && typeof direct === 'object' && !Array.isArray(direct) && direct.provider === 'openai'
        ? (direct as OpenAIContextUsage)
        : extractOpenAIContextUsageFromBlocks(message.content_blocks)
    if (!usage) continue

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
  let startIndex = 0
  for (let index = params.messages.length - 1; index >= 0; index--) {
    if (params.messages[index]?.note === '__auto_compaction_summary__') {
      startIndex = index
      break
    }
  }
  const contextMessages = params.messages.slice(startIndex)
  const promptAndContextTokens = (params.prompts ?? []).reduce<number>(
    (total, prompt) => total + safeEstimateTokenCount(prompt), 0
  )
  const messageTokens = contextMessages.reduce((total, message) => {
    if (!message) return total
    return total + safeEstimateTokenCount(message.content) +
      estimateContentBlocksForContext(message.content_blocks) + safeEstimateTokenCount(message.tool_calls)
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
    openAIUsageHistory: openAIContextUsageHistory(contextMessages),
    source: resolved.source,
  }
}
