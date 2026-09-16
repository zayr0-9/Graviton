import type { CSSProperties } from 'react'
import type { ContentBlock, StreamEvent } from '@/features/chats/chatTypes'

// Configuration for collapsed content display
export const COLLAPSED_CONTENT_WORD_LIMIT = 15
export const PROCESS_RUN_GROUP_MIN_ITEMS = 4

/**
 * Chat message design tokens (docs/agent_context/agent_design.md).
 *
 * One rhythm for every content block kind: a message body is a `flex-col` stack with
 * `MESSAGE_BLOCK_STACK_CLASS`, every render item is exactly one child of that stack, and no
 * item carries its own vertical margin. Horizontal alignment comes from one inset
 * (`MESSAGE_BLOCK_INSET_CLASS`) shared by text, images, and the label of every disclosure
 * row, so prose and process labels sit on the same left edge.
 */
export const MESSAGE_BLOCK_STACK_CLASS = 'flex min-w-0 w-full flex-col gap-1.5'
export const MESSAGE_BLOCK_INSET_CLASS = 'px-2.5'

/**
 * Type scale for message chrome. Four steps only, because near-duplicate sizes read as noise
 * rather than hierarchy. Values are em-relative so the chat font size preference scales them
 * together.
 *
 * NEVER apply two of these to nested elements. They are em-relative, so a label sized here
 * inside a slot also sized here renders at the product of the two. `DISCLOSURE_LABEL_LAYOUT_CLASS`
 * exists for exactly that reason: it carries the layout of the label slot and no typography, so a
 * caller-supplied node can bring its own.
 */
/** Row labels, collapsed summaries, reasoning prose, menu items. */
export const TEXT_LABEL_CLASS = 'text-[0.8125em]'
/** Card titles, field rows, action pills, meta text. */
export const TEXT_DETAIL_CLASS = 'text-[0.75em]'
/** Badges, section labels, index chips, uppercase captions. */
export const TEXT_MICRO_CLASS = 'text-[0.6875em]'
/** Model name and elapsed label, which sit beside a control rather than in the flow. */
export const TEXT_NANO_CLASS = 'text-[0.625em]'

/** Fast color-only feedback. Never `transition-all` in message chrome. */
export const FAST_COLOR_TRANSITION_CLASS = 'transition-[background-color,color,opacity] duration-150 ease-out'
export const FOCUS_RING_CLASS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent dark:focus-visible:ring-orange-400/70'

/** Collapsible header row shared by reasoning, tool cards, and grouped agent steps. */
export const DISCLOSURE_ROW_CLASS = `flex h-8 min-w-0 w-full items-center gap-2 rounded-xl ${MESSAGE_BLOCK_INSET_CLASS} text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05] ${FAST_COLOR_TRANSITION_CLASS} ${FOCUS_RING_CLASS}`
/** Layout of the label slot, with no typography, for a caller-supplied node. */
export const DISCLOSURE_LABEL_LAYOUT_CLASS = 'min-w-0 shrink-0 max-w-[60%] truncate'
export const DISCLOSURE_LABEL_CLASS = `${DISCLOSURE_LABEL_LAYOUT_CLASS} ${TEXT_LABEL_CLASS} font-medium leading-none`
export const DISCLOSURE_SUMMARY_CLASS = `min-w-0 flex-1 truncate ${TEXT_LABEL_CLASS} leading-none text-neutral-500 dark:text-neutral-500`
export const DISCLOSURE_CHEVRON_CLASS =
  'shrink-0 text-neutral-400 dark:text-neutral-600 transition-transform duration-150 ease-out motion-reduce:transition-none'
/** Legacy chevron classes still used by SubagentTranscript. Same motion token as `DISCLOSURE_CHEVRON_CLASS`. */
export const TOOL_CHEVRON_BASE_CLASS = `tool-chevron h-3.5 w-3.5 ${DISCLOSURE_CHEVRON_CLASS} group-hover/tool:text-neutral-500 dark:group-hover/tool:text-neutral-400`
export const REASONING_CHEVRON_BASE_CLASS = `tool-chevron h-3.5 w-3.5 ${DISCLOSURE_CHEVRON_CLASS} group-hover/reason:text-neutral-500 dark:group-hover/reason:text-neutral-400`
/** Body of an expanded disclosure. Aligns to the row label through the same inset. */
export const DISCLOSURE_BODY_CLASS = `${MESSAGE_BLOCK_INSET_CLASS} pb-2 pt-1`

/** Flat glass surfaces. Tone only, no borders, no shadows. */
export const SURFACE_CARD_CLASS = 'min-w-0 max-w-full overflow-hidden rounded-2xl bg-black/[0.035] dark:bg-white/[0.04]'
export const SURFACE_INNER_CLASS = 'min-w-0 max-w-full overflow-hidden rounded-xl bg-black/[0.03] dark:bg-white/[0.035]'
export const SURFACE_CARD_PADDING_CLASS = 'px-3 py-2'

/** Monospace detail text used by tool inputs and outputs. */
export const MONO_DETAIL_CLASS =
  `min-w-0 max-w-full break-words font-mono ${TEXT_DETAIL_CLASS} leading-relaxed text-neutral-600 dark:text-neutral-400 [overflow-wrap:anywhere]`
export const MONO_KEY_CLASS = 'text-neutral-400 dark:text-neutral-600'

/** Small pill action used inside tool cards (viewer, transcript, load app). */
export const ACTION_PILL_CLASS = `inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-black/[0.05] px-2.5 ${TEXT_DETAIL_CLASS} font-medium text-neutral-600 hover:bg-black/[0.09] hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.06] dark:text-neutral-300 dark:hover:bg-white/[0.11] dark:hover:text-white ${FAST_COLOR_TRANSITION_CLASS} ${FOCUS_RING_CLASS}`

/** Tool name states. Kept as exports because SubagentTranscript reuses them. */
export const TOOL_NAME_BASE_CLASS = `min-w-0 max-w-full truncate ${TEXT_LABEL_CLASS} font-medium leading-none text-neutral-700 dark:text-neutral-300`
export const TOOL_NAME_RUNNING_CLASS = `${TOOL_NAME_BASE_CLASS} tool-name-shimmer`
export const TOOL_NAME_SUCCESS_CLASS = TOOL_NAME_BASE_CLASS
export const TOOL_NAME_ERROR_CLASS = `${TOOL_NAME_BASE_CLASS} text-red-600 dark:text-red-400`

const CHAT_MARKDOWN_PROSE_TIGHT_CLASS =
  'leading-[1.55] prose-p:my-1.5 prose-p:leading-[1.55] prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-li:leading-[1.5] prose-headings:mt-4 prose-headings:mb-2 prose-headings:leading-[1.25] prose-h1:text-[1.35em] prose-h2:text-[1.22em] prose-h3:text-[1.12em] prose-pre:my-3 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'

export const CHAT_NORMAL_TEXT_SIZE_CLASS = 'text-[16px] sm:text-[14px] xl:text-[14px] 2xl:text-[14px] 3xl:text-[14px]'

export const getChatFontSizeOffsetStyle = (fontSizeOffset?: number): CSSProperties | undefined =>
  fontSizeOffset ? { fontSize: `calc(1em + ${fontSizeOffset}px)` } : undefined

/** Prose text block. Same inset as every disclosure row so text and labels share one left edge. */
export const SHARED_TEXT_MARKDOWN_CLASS = `chat-markdown prose max-w-none dark:prose-invert w-full min-w-0 ${MESSAGE_BLOCK_INSET_CLASS} py-1 ${CHAT_NORMAL_TEXT_SIZE_CLASS} ${CHAT_MARKDOWN_PROSE_TIGHT_CLASS}`
export const REASONING_TEXT_MARKDOWN_CLASS = `chat-markdown ${TEXT_LABEL_CLASS} text-neutral-600 dark:text-neutral-400 prose max-w-none dark:prose-invert min-w-0 ${CHAT_MARKDOWN_PROSE_TIGHT_CLASS}`
export const MESSAGE_IMAGE_WRAPPER_CLASS = `${MESSAGE_BLOCK_INSET_CLASS} py-1`
export const MESSAGE_IMAGE_CLASS = 'max-w-full max-h-96 object-contain rounded-2xl'

/**
 * Block types that draw something to READ, as opposed to a step of agent work.
 *
 * Everything absent from this set draws nothing or folds into a tool card: `tool_result`,
 * `reasoning_details`, and provider bookkeeping such as `openai_context_usage`. Unknown types
 * belong here too, because `buildContentBlockRenderItems` falls through and draws nothing for
 * them. Listing what IS readable, rather than what is not, keeps this predicate correct when a
 * provider adds a new metadata block.
 */
const READABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'image',
  'error',
  'context_injection',
  'responses_output_items',
])

/**
 * True when a row draws only agent process blocks: reasoning rows and tool cards, with nothing
 * to read.
 *
 * Such a row is one step of a run, so it carries less vertical padding and joins the tight run
 * with its neighbours. Without this, a run of one-tool-per-message steps shows a wide gap at
 * every message boundary and a tight gap inside each message, which reads as uneven spacing
 * around every reasoning row.
 */
export const isProcessOnlyBlockSet = (blocks: ContentBlock[] | undefined): boolean => {
  if (!Array.isArray(blocks) || blocks.length === 0) return false

  let hasProcessBlock = false
  for (const block of blocks) {
    if (!block) continue

    if (block.type === 'thinking' || block.type === 'tool_use') {
      hasProcessBlock = true
      continue
    }
    if (block.type === 'text') {
      // An empty text block draws nothing, so it does not make the row readable.
      if (typeof block.content === 'string' && block.content.trim().length > 0) return false
      continue
    }
    if (READABLE_BLOCK_TYPES.has(block.type)) return false
    // Anything else draws nothing, so it cannot disqualify the row.
  }
  return hasProcessBlock
}

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

/** JSON-ish stringifier for tool inputs and outputs shown in mono detail rows. */
export const stringifyToolValue = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === null || typeof value === 'undefined') return String(value)
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
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

export const extractAssistantTextsFromResponsesOutputItems = (items: any[]): string[] => {
  const extracted: string[] = []

  for (const item of items) {
    if (!item || typeof item !== 'object' || item.type !== 'message' || item.role !== 'assistant') continue
    if (!Array.isArray(item.content)) continue

    const text = item.content
      .map((part: any) => {
        if (!part || typeof part !== 'object') return ''
        return typeof part.text === 'string' ? part.text : ''
      })
      .filter(Boolean)
      .join('')
      .trim()

    if (text) {
      extracted.push(text)
    }
  }

  return extracted
}

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
