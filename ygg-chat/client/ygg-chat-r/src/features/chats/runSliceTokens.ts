import { estimateContentBlocksForContext, safeEstimateTokenCount } from './contextTokenEstimate'
import { parseMessageMeta } from '../../../../../shared/contextInjection'
import type { Message } from './chatTypes'

export interface SliceTokenEstimate {
  total: number
  user: number
  assistant: number
  tools: number
}

function array(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
  }
  return []
}

/** Count one canonical copy of transcript payloads, not provider usage or replay history. */
export function estimateRunSliceMessage(message: Message): SliceTokenEstimate {
  const result: SliceTokenEstimate = { total: 0, user: 0, assistant: 0, tools: 0 }
  const meta = parseMessageMeta(message.meta)
  // App-authored notices/context setup are not new user/model/tool work.
  if (message.role === 'system' || meta?.runStatistics && (meta.runStatistics as any).kind === 'terminal_error' ||
      ['context_injection', 'operation_mode_change', 'full_access_change'].includes(String(meta?.kind))) return result
  const blocks = array(message.content_blocks)
  const text = new Set<string>()
  const reasoning = new Set<string>()
  const calls = new Set<string>()
  const results = new Set<string>()
  const countText = (value: unknown, target: Set<string>) => {
    if (typeof value !== 'string' || !value) return 0
    target.add(value)
    return safeEstimateTokenCount(value)
  }
  const countPayload = (value: unknown) => {
    // Reuse the meter's image sanitization, without counting protocol/usage metadata.
    if (value == null) return 0
    if (typeof value === 'string' && !value.includes('data:image/')) return safeEstimateTokenCount(value)
    return estimateContentBlocksForContext([{ content: value }])
  }
  for (const block of blocks) {
    if (block.type === 'text') result.assistant += countText(block.content ?? block.text, text)
    else if (block.type === 'thinking') result.assistant += countText(block.content, reasoning)
    else if (block.type === 'tool_use') {
      const id = String(block.id ?? JSON.stringify([block.name, block.input]))
      if (!calls.has(id)) {
        calls.add(id)
        result.tools += safeEstimateTokenCount(block.name) + countPayload(block.input)
      }
    } else if (block.type === 'tool_result') {
      const id = String(block.tool_use_id ?? JSON.stringify(block.content))
      if (!results.has(id)) { results.add(id); result.tools += countPayload(block.content) }
    }
  }
  // Responses items are an alternate copy of the same output, not additional content.
  if (text.size === 0 && reasoning.size === 0) {
    for (const block of blocks.filter(block => block.type === 'responses_output_items')) {
      for (const item of array(block.items)) {
        if (item.type === 'message') {
          for (const part of array(item.content)) result.assistant += countText(part.text, text)
        } else if (item.type === 'reasoning') {
          for (const part of array(item.summary)) result.assistant += countText(part.text, reasoning)
        }
      }
    }
  }
  // Legacy fields mirror blocks; only use them if their canonical representation is absent.
  if (message.role === 'user') {
    result.user = safeEstimateTokenCount(message.content)
    result.assistant = 0
  } else if (message.role === 'tool') {
    result.tools += safeEstimateTokenCount(message.content)
    result.assistant = 0
  } else {
    if (text.size === 0) result.assistant += countText(message.content, text)
    if (reasoning.size === 0) result.assistant += countText(message.thinking_block, reasoning)
  }
  for (const call of array(message.tool_calls)) {
    const id = String(call.id ?? JSON.stringify([call.name, call.arguments]))
    if (!calls.has(id)) {
      calls.add(id)
      result.tools += safeEstimateTokenCount(call.name) + countPayload(call.arguments)
    }
    if (call.result != null && !results.has(id)) { results.add(id); result.tools += countPayload(call.result) }
  }
  result.total = result.user + result.assistant + result.tools
  return result
}

/** Prefix totals make several run slices linear rather than rescanning the branch per run. */
export function runSliceTokenPrefixes(messages: readonly (Message | undefined)[]): SliceTokenEstimate[] {
  const prefixes: SliceTokenEstimate[] = [{ total: 0, user: 0, assistant: 0, tools: 0 }]
  for (const message of messages) {
    const count = message ? estimateRunSliceMessage(message) : { total: 0, user: 0, assistant: 0, tools: 0 }
    const previous = prefixes[prefixes.length - 1]
    prefixes.push({ total: previous.total + count.total, user: previous.user + count.user,
      assistant: previous.assistant + count.assistant, tools: previous.tools + count.tools })
  }
  return prefixes
}
