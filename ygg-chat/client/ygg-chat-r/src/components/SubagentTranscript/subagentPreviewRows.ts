import type { SubagentRunRow } from '../../../../../shared/types'
import type { ContentBlock } from '../../features/chats/chatTypes'
import type { PreviewRow } from '../RunningAgentsFloatingButton/agentPreviewContent'

function arrayField(value: unknown): any[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
}

/** Keep contiguous assistant work in one row so tool results and reasoning use Chat's grouping.
 * User steering and system messages start new rows even when they repeat the initial prompt. */
export function subagentPreviewRows(run: SubagentRunRow): PreviewRow[] {
  const rows: PreviewRow[] = []
  for (const [index, message] of (run.messages ?? []).entries()) {
    if (index === 0 && message.role === 'user' && message.content?.trim() === run.prompt?.trim()) continue
    const blocks: ContentBlock[] = arrayField(message.content_blocks).map(block =>
      block.type === 'text' ? { ...block, content: block.content ?? block.text ?? '' } : block)
    if (message.thinking_block && !blocks.some(block => block.type === 'thinking')) {
      blocks.unshift({ type: 'thinking', index: 0, content: message.thinking_block })
    }
    if (message.role === 'tool' && message.tool_call_id && !blocks.some(block => block.type === 'tool_result')) {
      blocks.push({ type: 'tool_result', index: 0, tool_use_id: message.tool_call_id, content: message.content, is_error: false })
    } else if (message.content?.trim() && !blocks.some(block => block.type === 'text' || (message.role === 'tool' && block.type === 'tool_result'))) {
      const afterThinking = blocks[0]?.type === 'thinking' ? 1 : 0
      blocks.splice(afterThinking, 0, { type: 'text', index: 0, content: message.content })
    }
    for (const call of arrayField(message.tool_calls)) {
      if (call.id && !blocks.some(block => block.type === 'tool_use' && block.id === call.id)) {
        blocks.push({ type: 'tool_use', index: 0, id: call.id, name: call.name ?? call.function?.name ?? 'tool',
          input: call.arguments ?? call.function?.arguments ?? {} })
      }
    }
    if (!blocks.length) continue
    const role = message.role === 'user' || message.role === 'system' ? message.role : 'assistant'
    const previous = rows[rows.length - 1]
    const row = role === 'assistant' && previous?.role === 'assistant' ? previous : null
    const offset = row?.blocks.length ?? 0
    const indexed = blocks.map((block, i) => ({ ...block, index: offset + i }))
    if (row) row.blocks.push(...indexed)
    else rows.push({ key: message.id, role, content: message.content ?? '', blocks: indexed })
  }
  if (run.status === 'error' && run.error) {
    rows.push({ key: 'run-error', role: 'assistant', content: `Subagent error: ${run.error}`, blocks: [] })
  }
  return rows
}
