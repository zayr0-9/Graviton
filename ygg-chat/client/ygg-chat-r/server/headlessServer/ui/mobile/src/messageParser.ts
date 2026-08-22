import type { MobileMessage, ParsedRenderItem, ToolCallLike, ToolGroup, ToolResultLike } from './types'

const parseMaybeJson = <T>(value: unknown): T | null => {
  if (value == null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return value as T
}

const extractReasoningTextsFromResponsesOutputItems = (items: unknown): string[] => {
  if (!Array.isArray(items)) return []

  const reasoningTexts: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const itemRecord = item as Record<string, unknown>
    if (itemRecord.type !== 'reasoning') continue

    const content = Array.isArray(itemRecord.content) ? itemRecord.content : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const partRecord = part as Record<string, unknown>
      if (partRecord.type === 'reasoning_text' && typeof partRecord.text === 'string' && partRecord.text.trim()) {
        reasoningTexts.push(partRecord.text)
      }
    }

    const summary = Array.isArray(itemRecord.summary) ? itemRecord.summary : []
    for (const part of summary) {
      if (!part || typeof part !== 'object') continue
      const partRecord = part as Record<string, unknown>
      if (typeof partRecord.text === 'string' && partRecord.text.trim()) {
        reasoningTexts.push(partRecord.text)
      }
    }
  }

  return reasoningTexts
}

const normalizeReasoningText = (value: string): string => value.trim().replace(/\s+/g, ' ')

const pushUniqueReasoningItem = (
  renderItems: ParsedRenderItem[],
  seen: Set<string>,
  key: string,
  text: string
) => {
  const normalized = normalizeReasoningText(text)
  if (!normalized) return
  if (seen.has(normalized)) return

  seen.add(normalized)
  renderItems.push({ type: 'reasoning', key, text })
}

const toToolCallArray = (message: MobileMessage): ToolCallLike[] => {
  const raw = parseMaybeJson<unknown>(message.tool_calls)
  if (Array.isArray(raw)) return raw as ToolCallLike[]
  if (raw && typeof raw === 'object') return [raw as ToolCallLike]
  return []
}

const normalizeToolArgs = (value: unknown): Record<string, unknown> | undefined => {
  if (value == null) return undefined

  if (typeof value === 'string') {
    const parsed = parseMaybeJson<unknown>(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return undefined
}

export type HtmlToolPayload = {
  html: string
  toolName?: string | null
}

const extractHtmlFromResolvedPayload = (resolved: unknown): HtmlToolPayload | null => {
  if (!resolved || typeof resolved !== 'object') return null

  const resolvedRecord = resolved as Record<string, unknown>

  if (typeof resolvedRecord.html === 'string' && resolvedRecord.html.trim()) {
    return {
      html: resolvedRecord.html,
      toolName:
        typeof resolvedRecord.toolName === 'string'
          ? resolvedRecord.toolName
          : typeof resolvedRecord.tool_name === 'string'
            ? resolvedRecord.tool_name
            : null,
    }
  }

  if (resolvedRecord.type === 'text/html' && typeof resolvedRecord.content === 'string' && resolvedRecord.content.trim()) {
    return {
      html: resolvedRecord.content,
      toolName:
        typeof resolvedRecord.toolName === 'string'
          ? resolvedRecord.toolName
          : typeof resolvedRecord.tool_name === 'string'
            ? resolvedRecord.tool_name
            : null,
    }
  }

  return null
}

export const extractHtmlFromToolResult = (content: unknown): HtmlToolPayload | null => {
  if (content == null) return null

  if (typeof content === 'string') {
    const parsed = parseMaybeJson<unknown>(content)
    if (parsed == null) return null
    return extractHtmlFromResolvedPayload(parsed)
  }

  return extractHtmlFromResolvedPayload(content)
}

const ensureToolGroup = (groups: Map<string, ToolGroup>, order: string[], id: string, name: string, args?: unknown) => {
  const normalizedArgs = normalizeToolArgs(args)

  if (groups.has(id)) {
    const existing = groups.get(id)!
    if (!existing.name && name) existing.name = name
    if (!existing.args && normalizedArgs) existing.args = normalizedArgs
    return existing
  }

  const next: ToolGroup = {
    id,
    name: name || 'tool',
    args: normalizedArgs,
    results: [],
  }

  groups.set(id, next)
  order.push(id)
  return next
}

export const buildRenderItemsForMessage = (message: MobileMessage): ParsedRenderItem[] => {
  const renderItems: ParsedRenderItem[] = []
  const seenReasoningTexts = new Set<string>()
  const toolGroups = new Map<string, ToolGroup>()
  const toolOrder: string[] = []

  const contentBlocks = parseMaybeJson<any[]>(message.content_blocks)
  if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
    const sorted = [...contentBlocks].sort((a, b) => {
      const left = typeof a?.index === 'number' ? a.index : 0
      const right = typeof b?.index === 'number' ? b.index : 0
      return left - right
    })

    const hasPrimaryReasoningBlock = sorted.some(block => {
      if (!block || typeof block !== 'object') return false
      if (block.type === 'thinking' && typeof block.content === 'string' && block.content.trim()) return true
      if (block.type === 'reasoning_details' && Array.isArray(block.reasoningDetails)) {
        return block.reasoningDetails.some((detail: any) => typeof detail?.text === 'string' && detail.text.trim())
      }
      return false
    })

    sorted.forEach((block, index) => {
      if (!block || typeof block !== 'object') return

      if (block.type === 'text' && typeof block.content === 'string' && block.content.trim()) {
        renderItems.push({ type: 'text', key: `text-${index}`, text: block.content })
        return
      }

      if (block.type === 'thinking' && typeof block.content === 'string' && block.content.trim()) {
        pushUniqueReasoningItem(renderItems, seenReasoningTexts, `thinking-${index}`, block.content)
        return
      }

      if (block.type === 'reasoning_details' && Array.isArray(block.reasoningDetails)) {
        const text = block.reasoningDetails
          .map((detail: any) => (typeof detail?.text === 'string' ? detail.text : ''))
          .filter(Boolean)
          .join('\n')
        if (text.trim()) {
          pushUniqueReasoningItem(renderItems, seenReasoningTexts, `reasoning-details-${index}`, text)
        }
        return
      }

      if (block.type === 'tool_use') {
        const id = String(block.id || `tool-${index}`)
        ensureToolGroup(toolGroups, toolOrder, id, String(block.name || 'tool'), block.input)
        return
      }

      if (block.type === 'tool_result') {
        const id = String(block.tool_use_id || `tool-result-${index}`)
        const group = ensureToolGroup(toolGroups, toolOrder, id, 'tool')
        group.results.push({
          tool_use_id: id,
          content: block.content,
          is_error: Boolean(block.is_error),
        })
        return
      }

      if (block.type === 'responses_output_items') {
        // Prefer content_blocks reasoning as the primary source of truth.
        // Only fall back to responses_output_items when no primary reasoning block exists.
        if (hasPrimaryReasoningBlock) return

        const extracted = extractReasoningTextsFromResponsesOutputItems(block.items)
        extracted.forEach((text, reasoningIndex) => {
          pushUniqueReasoningItem(renderItems, seenReasoningTexts, `responses-reasoning-${index}-${reasoningIndex}`, text)
        })
      }
    })
  } else if (typeof message.content === 'string' && message.content.trim()) {
    renderItems.push({ type: 'text', key: 'message-content', text: message.content })
  }

  // Legacy fallback: only consume message.tool_calls when content_blocks did not already define tool groups.
  if (toolOrder.length === 0) {
    const legacyToolCalls = toToolCallArray(message)
    for (const toolCall of legacyToolCalls) {
      const id = String(toolCall.id || `legacy-tool-${toolOrder.length}`)
      const group = ensureToolGroup(toolGroups, toolOrder, id, String(toolCall.name || 'tool'), toolCall.arguments)
      if (toolCall.result) {
        group.results.push({
          tool_use_id: id,
          content: toolCall.result,
          is_error: toolCall.status === 'failed',
        })
      }
    }
  }

  toolOrder.forEach((id, index) => {
    const group = toolGroups.get(id)
    if (!group) return
    renderItems.push({ type: 'tool', key: `tool-group-${index}-${id}`, group })
  })

  return renderItems
}

export const toReadableToolResult = (result: ToolResultLike): string => {
  if (typeof result.content === 'string') return result.content
  try {
    return JSON.stringify(result.content, null, 2)
  } catch {
    return String(result.content)
  }
}
