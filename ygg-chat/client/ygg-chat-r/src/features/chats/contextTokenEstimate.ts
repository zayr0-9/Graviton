import { estimateTokenCount } from 'tokenx'
import {
  effectiveOpenAIContextTokens,
  extractOpenAIContextUsageFromBlocks,
  type OpenAIContextUsage,
} from '../../../../../shared/contextUsage'
import type { Message } from './chatTypes'

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

export function latestOpenAIContextUsage(messages: Array<Message | null | undefined>): OpenAIContextUsage | null {
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
  messages: Array<Message | null | undefined>
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
