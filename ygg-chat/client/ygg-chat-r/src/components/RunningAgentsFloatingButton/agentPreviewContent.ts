import { extractAssistantTextsFromResponsesOutputItems, extractReasoningTextsFromResponsesOutputItems } from '../ChatMessage/chatMessageShared'
import type { ContentBlock, StreamEvent } from '../../features/chats/chatTypes'
import type { AgentPreviewEntry, AgentRunPreview } from '../../features/chats/agentRunPreviewSlice'
import { isHeimdallScaffoldingMessage } from '../Heimdall/heimdallNodeVisibility'
import { isCompactionSummary, SUMMARY_PLACEHOLDER } from '../../features/chats/summaryPresentation'

export interface PreviewRow {
  key: string
  role: 'user' | 'assistant' | 'system' | 'ex_agent' | 'tool'
  content: string
  blocks: ContentBlock[]
}

function eventBlocks(events: StreamEvent[]): ContentBlock[] {
  return events.flatMap((event, index): ContentBlock[] => {
    switch (event.type) {
      case 'text': return [{ type: 'text', index, content: event.delta ?? event.content ?? '' }]
      case 'reasoning': return [{ type: 'thinking', index, content: event.delta ?? event.content ?? '' }]
      case 'tool_call': return event.toolCall ? [{ type: 'tool_use', index, id: event.toolCall.id,
        name: event.toolCall.name, input: event.toolCall.arguments }] : []
      case 'tool_result': return event.toolResult ? [{ type: 'tool_result', index, ...event.toolResult }] : []
      case 'image': return event.url ? [{ type: 'image', index, url: event.url, mimeType: event.mimeType ?? '' }] : []
      case 'notice': return event.content ? [{ type: 'text', index, content: event.content }] : []
      case 'error': return event.errorEnvelope ? [{ type: 'error', index, envelope: event.errorEnvelope, excludeFromContext: true }] : []
      default: return []
    }
  })
}

// Tool failures are shown in their results, not as a second preview bubble.
// Keep other error envelopes and all canonical retained data unchanged.
const isVisiblePreviewBlock = (block: ContentBlock): boolean =>
  block.type !== 'error' || block.envelope.code !== 'tool_failed'

function entryBlocks(entry: AgentPreviewEntry): ContentBlock[] {
  const { message, stream } = entry
  const live = stream ? eventBlocks(stream.events).filter(isVisiblePreviewBlock) : []
  let blocks = message ? (message.content_blocks ?? []).filter(isVisiblePreviewBlock) : live
  // Expand provider-only output before combining turns: otherwise ChatMessage's
  // explicit-block precedence would hide a responses-only turn beside a text turn.
  const explicit = blocks.some(block => ['text', 'thinking', 'tool_use', 'image', 'reasoning_details', 'error'].includes(block.type))
  blocks = blocks.flatMap((block): ContentBlock[] => {
    const providerBlock = block as unknown as { type: string; items?: unknown[] }
    if (providerBlock.type !== 'responses_output_items') return [block]
    if (explicit || !Array.isArray(providerBlock.items)) return []
    return providerBlock.items.flatMap((item): ContentBlock[] => [
      ...extractReasoningTextsFromResponsesOutputItems([item]).map(content => ({ type: 'thinking' as const, index: 0, content })),
      ...extractAssistantTextsFromResponsesOutputItems([item]).map(content => ({ type: 'text' as const, index: 0, content })),
    ])
  })
  if (!blocks.length) {
    if (message?.thinking_block || stream?.thinkingBuffer) blocks.push({ type: 'thinking', index: 0,
      content: message?.thinking_block || stream?.thinkingBuffer || '' })
    const calls = message?.tool_calls
    if (Array.isArray(calls)) {
      for (const call of calls) {
        blocks.push({ type: 'tool_use', index: blocks.length, id: call.id,
          name: call.name ?? call.function?.name ?? 'tool', input: call.arguments ?? call.function?.arguments ?? {} })
      }
    }
    const text = message?.content || stream?.buffer
    if (text) blocks.push({ type: 'text', index: blocks.length, content: text })
  }
  // A persisted assistant may arrive before its tool results. Keep later results
  // and failures until an enriched persisted row supersedes them.
  if (message) {
    for (const block of live) {
      if (block.type === 'tool_result') {
        const current = stream?.events.find(event => event.type === 'tool_result' && event.toolResult?.tool_use_id === block.tool_use_id)
        const persisted = entry.persistedEvents?.find(event => event.type === 'tool_result' && event.toolResult?.tool_use_id === block.tool_use_id)
        const index = blocks.findIndex(old => old.type === 'tool_result' && old.tool_use_id === block.tool_use_id)
        if (index >= 0 && current === persisted) continue
        if (index >= 0) blocks[index] = block
        else blocks.push(block)
      } else if (block.type === 'tool_use' && !blocks.some(old => old.type === 'tool_use' && old.id === block.id)) {
        blocks.push(block)
      } else if (block.type === 'error' && !blocks.some(old => old.type === 'error' && old.envelope.code === block.envelope.code)) {
        blocks.push(block)
      }
    }
  }
  return blocks
}

/** Adjacent assistant turns share one presentation row, so existing ChatMessage
 * grouping spans turn boundaries without copying the Chat container's grouping logic.
 * User/system rows, prose blocks, images and failures retain their original order. */
export function buildAgentPreviewRows(run: AgentRunPreview): PreviewRow[] {
  const rows: PreviewRow[] = []
  for (const entry of run.entries) {
    // Rendering-only: retained canonical rows still include model-history scaffolding.
    if (entry.message && isHeimdallScaffoldingMessage(entry.message)) continue
    if (isCompactionSummary(entry.message)) {
      rows.push({ key: entry.key, role: 'system', content: SUMMARY_PLACEHOLDER,
        blocks: [{ type: 'text', index: 0, content: SUMMARY_PLACEHOLDER }] })
      continue
    }
    const role = entry.message?.role ?? 'assistant'
    const blocks = entryBlocks(entry)
    const previous = rows[rows.length - 1]
    if ((role === 'assistant' || role === 'ex_agent') && previous?.role === 'assistant') {
      previous.blocks.push(...blocks)
    } else {
      rows.push({ key: entry.key, role: role === 'ex_agent' ? 'assistant' : role,
        content: entry.message?.content ?? '', blocks })
    }
  }
  return rows.map(row => ({ ...row, blocks: row.blocks.map((block, index) => ({ ...block, index })) }))
}
