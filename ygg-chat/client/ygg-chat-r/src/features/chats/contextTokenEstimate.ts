import { estimateTokenCount } from 'tokenx'

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
  if (!value || typeof value !== 'object') return { value, changed: false }

  let changed = false
  const sanitizeBlock = (block: any): any => {
    if (!block || typeof block !== 'object') return block

    if (Array.isArray(block)) {
      const next = block.map(item => sanitizeBlock(item))
      return next
    }

    const next: any = { ...block }

    if (next.type === 'image') {
      for (const key of ['url', 'dataUrl', 'image_url', 'imageUrl']) {
        if (isImageDataUrl(next[key])) {
          next[key] = IMAGE_PAYLOAD_OMITTED_PLACEHOLDER
          changed = true
        }
      }
    }

    if (next.type === 'image_generation_call' && typeof next.result === 'string' && next.result.trim().length > 0) {
      next.result = IMAGE_PAYLOAD_OMITTED_PLACEHOLDER
      changed = true
    }

    if (next.type === 'responses_output_items' && Array.isArray(next.items)) {
      next.items = next.items.map((item: any) => sanitizeBlock(item))
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
