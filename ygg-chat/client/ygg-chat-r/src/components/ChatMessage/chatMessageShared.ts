import type { ContentBlock, StreamEvent } from '@/features/chats/chatTypes'

// Configuration for collapsed content display
export const COLLAPSED_CONTENT_WORD_LIMIT = 15
export const PROCESS_RUN_GROUP_MIN_ITEMS = 4

export const PROCESS_CARD_WRAPPER_CLASS = 'relative pl-6 pb-4 ml-2 '
export const PROCESS_CARD_REASONING_WRAPPER_CLASS = 'relative pl-6 pb-4 ml-2 mb-2 '
export const PROCESS_PIP_BASE_CLASS = 'absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full'
export const REASONING_PIP_CLASS = `${PROCESS_PIP_BASE_CLASS} bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.3)]`
export const TOOL_SUCCESS_PIP_CLASS = `${PROCESS_PIP_BASE_CLASS} bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]`
export const AGENT_RUN_PIP_CLASS = `${PROCESS_PIP_BASE_CLASS} bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.35)]`
export const TOOL_HEADER_BUTTON_CLASS =
  'flex items-center gap-2 group/tool hover:opacity-80 transition-opacity cursor-pointer outline-none'
export const TOOL_NAME_BADGE_CLASS =
  'font-mono text-xs bg-neutral-100 dark:bg-neutral-900 px-1.5 py-0.5 rounded-xl border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 group-hover/tool:border-neutral-400 dark:group-hover/tool:border-neutral-600 transition-colors'
export const TOOL_CHEVRON_BASE_CLASS =
  'tool-chevron w-3.5 h-3.5 text-neutral-400 dark:text-neutral-600 group-hover/tool:text-neutral-500 dark:group-hover/tool:text-neutral-400'
export const REASONING_CHEVRON_BASE_CLASS =
  'tool-chevron w-3.5 h-3.5 text-neutral-400 dark:text-neutral-600 group-hover/reason:text-neutral-500 dark:group-hover/reason:text-neutral-400'
export const AGENT_RUN_CHEVRON_BASE_CLASS =
  'tool-chevron w-3.5 h-3.5 text-neutral-400 dark:text-neutral-600 group-hover/run:text-neutral-500 dark:group-hover/run:text-neutral-400'
export const SHARED_TEXT_MARKDOWN_CLASS =
  'prose max-w-none dark:prose-invert w-full text-[16px] sm:text-[16px] 2xl:text-[20px] 3xl:text-[21px]'
export const LEGACY_TEXT_MARKDOWN_CLASS =
  'prose px-4 py-2 sm:px-1 max-w-none dark:prose-invert w-full text-[16px] md:text-[14px] lg:text-[14px] xl:text-[16px] 2xl:text-[20px] 3xl:text-[20px] 4xl:text-[20px]'
export const REASONING_TEXT_MARKDOWN_CLASS =
  'text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed prose max-w-none dark:prose-invert'
export const MESSAGE_IMAGE_WRAPPER_CLASS = 'my-3 mx-1'
export const MESSAGE_IMAGE_CLASS = 'max-w-full max-h-96 object-contain rounded-lg shadow-md'

export interface ToolCallRenderGroup {
  id: string
  name?: string
  args?: Record<string, any> | null
  results: Array<{ content: any; is_error?: boolean }>
  anchorIndex: number
}

// Helper function to convert contentBlocks to editable text
export const contentBlocksToEditableText = (blocks: ContentBlock[] | undefined): string => {
  if (!blocks || blocks.length === 0) return ''

  return blocks
    .sort((a, b) => a.index - b.index)
    .map(block => {
      if (block.type === 'text') {
        return block.content
      } else if (block.type === 'thinking') {
        return `[THINKING]\n${block.content}\n[/THINKING]`
      } else if (block.type === 'tool_use') {
        return `[TOOL_USE: ${block.name}]\n${JSON.stringify(block.input, null, 2)}\n[/TOOL_USE]`
      } else if (block.type === 'tool_result') {
        const resultContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2)
        return `[TOOL_RESULT]\n${resultContent}\n[/TOOL_RESULT]`
      }
      return ''
    })
    .join('\n\n')
}

// Helper function to convert edited text back to contentBlocks
// Robust parser that handles malformed input gracefully
export const editableTextToContentBlocks = (text: string): ContentBlock[] => {
  if (!text || !text.trim()) {
    return []
  }

  const blocks: ContentBlock[] = []
  let currentIndex = 0

  const thinkingPattern = /\[THINKING\]([\s\S]*?)\[\/THINKING\]/g
  const toolUsePattern = /\[TOOL_USE:\s*([^\]]+)\]([\s\S]*?)\[\/TOOL_USE\]/g
  const toolResultPattern = /\[TOOL_RESULT\]([\s\S]*?)\[\/TOOL_RESULT\]/g

  interface PotentialBlock {
    type: 'thinking' | 'tool_use' | 'tool_result'
    start: number
    end: number
    content: string
    name?: string
  }

  const potentialBlocks: PotentialBlock[] = []

  let match
  thinkingPattern.lastIndex = 0
  while ((match = thinkingPattern.exec(text)) !== null) {
    potentialBlocks.push({
      type: 'thinking',
      start: match.index,
      end: match.index + match[0].length,
      content: match[1].trim(),
    })
  }

  toolUsePattern.lastIndex = 0
  while ((match = toolUsePattern.exec(text)) !== null) {
    const toolName = match[1].trim()
    const toolInput = match[2].trim()

    try {
      JSON.parse(toolInput)
      potentialBlocks.push({
        type: 'tool_use',
        start: match.index,
        end: match.index + match[0].length,
        name: toolName,
        content: toolInput,
      })
    } catch (_e) {
      // Invalid JSON - skip this block, will be treated as plain text later
    }
  }

  toolResultPattern.lastIndex = 0
  while ((match = toolResultPattern.exec(text)) !== null) {
    potentialBlocks.push({
      type: 'tool_result',
      start: match.index,
      end: match.index + match[0].length,
      content: match[1].trim(),
    })
  }

  potentialBlocks.sort((a, b) => a.start - b.start)

  const validBlocks: PotentialBlock[] = []
  for (const block of potentialBlocks) {
    let overlaps = false

    for (const validBlock of validBlocks) {
      if (block.start < validBlock.end && block.end > validBlock.start) {
        overlaps = true
        break
      }
    }

    if (!overlaps) {
      validBlocks.push(block)
    }
  }

  let position = 0

  for (const block of validBlocks) {
    if (block.start > position) {
      const plainText = text.substring(position, block.start).trim()
      if (plainText) {
        blocks.push({
          type: 'text',
          index: currentIndex++,
          content: plainText,
        })
      }
    }

    if (block.type === 'thinking') {
      blocks.push({
        type: 'thinking',
        index: currentIndex++,
        content: block.content,
      })
    } else if (block.type === 'tool_use' && block.name) {
      try {
        blocks.push({
          type: 'tool_use',
          index: currentIndex++,
          id: `tool_${Date.now()}_${currentIndex}`,
          name: block.name,
          input: JSON.parse(block.content),
        })
      } catch (_e) {
        const textContent = text.substring(block.start, block.end)
        blocks.push({
          type: 'text',
          index: currentIndex++,
          content: textContent,
        })
      }
    } else if (block.type === 'tool_result') {
      let resultContent: any
      try {
        resultContent = JSON.parse(block.content)
      } catch (_e) {
        resultContent = block.content
      }

      blocks.push({
        type: 'tool_result',
        index: currentIndex++,
        tool_use_id: 'unknown_tool',
        content: resultContent,
        is_error: false,
      })
    }

    position = block.end
  }

  if (position < text.length) {
    const plainText = text.substring(position).trim()
    if (plainText) {
      blocks.push({
        type: 'text',
        index: currentIndex++,
        content: plainText,
      })
    }
  }

  if (blocks.length === 0) {
    const trimmedText = text.trim()
    if (trimmedText) {
      return [
        {
          type: 'text',
          index: 0,
          content: trimmedText,
        },
      ]
    }
    return []
  }

  return blocks
}

export const buildToolCallGroupsFromStream = (events?: StreamEvent[]) => {
  if (!events || events.length === 0) return new Map<number, ToolCallRenderGroup>()

  const groupsById = new Map<string, ToolCallRenderGroup>()
  const mapByIndex = new Map<number, ToolCallRenderGroup>()

  events.forEach((event, idx) => {
    if (event.type === 'tool_call' && event.toolCall) {
      const id = event.toolCall.id
      if (!groupsById.has(id)) {
        groupsById.set(id, {
          id,
          name: event.toolCall.name,
          args: event.toolCall.arguments,
          results: [],
          anchorIndex: idx,
        })
      } else {
        const existingGroup = groupsById.get(id)!
        existingGroup.name = event.toolCall.name
        existingGroup.args = event.toolCall.arguments
        existingGroup.anchorIndex = idx
      }
      mapByIndex.set(idx, groupsById.get(id)!)
    } else if (event.type === 'tool_result' && event.toolResult) {
      const target = groupsById.get(event.toolResult.tool_use_id)
      if (target) {
        target.results.push({ content: event.toolResult.content, is_error: event.toolResult.is_error })
        mapByIndex.set(idx, target)
      } else {
        const orphanedGroup: ToolCallRenderGroup = {
          id: event.toolResult.tool_use_id,
          name: undefined,
          args: null,
          results: [{ content: event.toolResult.content, is_error: event.toolResult.is_error }],
          anchorIndex: -1,
        }
        groupsById.set(event.toolResult.tool_use_id, orphanedGroup)
        mapByIndex.set(idx, orphanedGroup)
      }
    }
  })

  return mapByIndex
}

export const buildToolCallGroupsFromBlocks = (blocks?: ContentBlock[]) => {
  if (!blocks || blocks.length === 0) return new Map<number, ToolCallRenderGroup>()

  const groupsById = new Map<string, ToolCallRenderGroup>()
  const mapByIndex = new Map<number, ToolCallRenderGroup>()

  blocks.forEach((block, idx) => {
    if (block.type === 'tool_use') {
      const id = block.id || `tool-${idx}`
      if (!groupsById.has(id)) {
        const group: ToolCallRenderGroup = {
          id,
          name: block.name,
          args: block.input,
          results: [],
          anchorIndex: idx,
        }
        groupsById.set(id, group)
        mapByIndex.set(idx, group)
      }
    } else if (block.type === 'tool_result') {
      const id = block.tool_use_id || `tool-result-${idx}`
      const target = groupsById.get(id)
      if (target) {
        target.results.push({ content: block.content, is_error: block.is_error })
      } else {
        const fallback: ToolCallRenderGroup = {
          id,
          name: 'Tool Result',
          args: null,
          results: [{ content: block.content, is_error: block.is_error }],
          anchorIndex: idx,
        }
        mapByIndex.set(idx, fallback)
      }
    }
  })

  return mapByIndex
}

export const formatToolResultContent = (content: any) => {
  if (typeof content === 'string') return content
  if (content == null) return ''
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

export const formatToolResultSummary = (content: any): string | null => {
  try {
    const data = typeof content === 'string' ? JSON.parse(content) : content
    if (!data || typeof data !== 'object' || !('success' in data)) return null
    return data.success ? 'success' : 'failure'
  } catch {
    return null
  }
}

export const normalizeReasoningTextForComparison = (text: string): string => text.replace(/\s+/g, ' ').trim()

export const extractReasoningTextsFromResponsesOutputItems = (items: any[]): string[] => {
  const extracted: string[] = []

  for (const item of items) {
    if (!item || typeof item !== 'object' || item.type !== 'reasoning') continue

    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'reasoning_text' && typeof part.text === 'string' && part.text.trim()) {
          extracted.push(part.text)
        }
      }
    }

    if (Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          extracted.push(part.text)
        }
      }
    }
  }

  return extracted
}

export const parseMcpQualifiedName = (qualifiedName: string) => {
  const match = qualifiedName.match(/^mcp__([^_]+)__(.+)$/)
  if (!match) return null
  return { serverName: match[1], toolName: match[2] }
}

export const extractHtmlFromToolResult = (content: any): { html: string; toolName?: string | null } | null => {
  if (!content) return null

  let resolved = content
  if (typeof resolved === 'string') {
    try {
      resolved = JSON.parse(resolved)
    } catch {
      return null
    }
  }
  if (typeof resolved === 'object' && resolved !== null && 'html' in resolved) {
    return {
      html: (resolved as any).html,
      toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
    }
  }

  if (
    typeof resolved === 'object' &&
    resolved !== null &&
    (resolved as any).type === 'text/html' &&
    typeof (resolved as any).content === 'string'
  ) {
    return {
      html: (resolved as any).content,
      toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
    }
  }
  return null
}
