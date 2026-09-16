import type { ContentBlock } from '@/features/chats/chatTypes'
import { PROCESS_RUN_GROUP_MIN_ITEMS } from './chatMessageShared'

/**
 * Height estimate for one virtual row, derived from the blocks the row will draw.
 *
 * WHY THIS EXISTS. TanStack Virtual places an unmeasured row at `estimateSize`, then
 * corrects `scrollTop` by the estimate-to-actual delta once a ResizeObserver measures it
 * (`resizeItem` in virtual-core). The React adapter re-renders after paint, so one frame
 * shows the corrected offset with the rows still at their old positions. The visible jump
 * is exactly that delta.
 *
 * virtual-core 3.17 suppresses this for RE-measurement while scrolling backward, but a
 * first measurement is still corrected in both directions. Scrolling up through a
 * conversation for the first time is all first measurements, so the only lever left on
 * that path is making the estimate close. A flat guess of 400px against a real 170px row
 * is a 230px jump; the model below is typically within a few tens of pixels.
 *
 * INVARIANT: the constants here mirror `ChatMessage.tsx` and `chatMessageShared.ts`.
 * Change the layout, change these. Being wrong costs scroll smoothness, never correctness.
 */

// ── Layout constants, mirrored from the renderer ──────────────────────────────────────

/** `MESSAGE_BLOCK_STACK_CLASS` gap-1.5 */
const STACK_GAP = 6
/** Text block `py-1` */
const TEXT_BLOCK_PADDING = 8
/** `DISCLOSURE_ROW_CLASS` h-8. Collapsed reasoning, tool card, and agent-steps rows. */
const DISCLOSURE_ROW = 32
/** Image block `py-1` plus a typical contained image. `max-h-96` caps the real one at 384. */
const IMAGE_BLOCK = 8 + 280
/** `ChatErrorBubble` with one line of text and no expanded detail. */
const ERROR_BLOCK = 110
/** `ContextInjectionCard` collapsed header. */
const CONTEXT_CARD = 44
/** Stream notice row, `h-8`. */
const NOTICE_ROW = 32

/** Outer wrapper: user `pt-3 pb-1`, others `py-1`. */
const OUTER_PADDING_USER = 16
const OUTER_PADDING_OTHER = 8
/** Tinted surface on user rows: `px-1.5 pt-2 pb-1`. */
const SURFACE_PADDING_USER = 12
const SURFACE_INSET_X_USER = 12
/** Role caption row `h-7`. */
const ROLE_CAPTION = 28
/** Actions row `h-10`. */
const ACTIONS_ROW = 40
/** Attachment strip: `py-2` plus one 80px tile row. */
const ATTACHMENTS_ROW = 96

/** Horizontal chrome: outer `sm:px-2` both sides, then block inset `px-2.5` both sides. */
const OUTER_INSET_X = 16
const BLOCK_INSET_X = 20

/** Base font at the `sm` breakpoint and above, which is every desktop window. */
const BASE_FONT_SIZE = 14
/** `leading-[1.55]` on prose. */
const PROSE_LINE_RATIO = 1.55
/** `prose-p:my-1.5`, collapsed between siblings. */
const PARAGRAPH_GAP = 6
/** Mean glyph advance for the app font at 14px. Measured by eye against real transcripts. */
const CHAR_WIDTH_RATIO = 0.515

/** Fenced code block: `h-8` header, `py-2.5` body padding, `prose-pre:my-3` both sides. */
const CODE_BLOCK_CHROME = 32 + 20 + 24
/** Code is rendered at `text-[0.85em]` with `leading-[1.5]`. */
const CODE_LINE_RATIO = 0.85 * 1.5

/** Always-expanded tool cards. Each is a 32px header row plus its own body. */
const TOOL_CARD_EDIT_DIFF = 32 + 96
const TOOL_CARD_PLAN_MD = 32 + 200
const TOOL_CARD_HTML = 32 + 400
const TOOL_CARD_MCP_APP = 32 + 640

// ── Text measurement ──────────────────────────────────────────────────────────────────

const normalizeToolName = (name: string | undefined): string =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[-\s]/g, '_')

/**
 * Height of one always-expanded tool card, or null when the tool draws the ordinary
 * collapsible row. Mirrors the variant branches in `ToolCallGroupCard`.
 */
const estimateSpecialToolCard = (block: Extract<ContentBlock, { type: 'tool_use' }>): number | null => {
  const name = normalizeToolName(block.name)
  const input = (block.input ?? {}) as Record<string, unknown>

  if (name === 'html_renderer' && typeof input.html === 'string') return TOOL_CARD_HTML
  if (name === 'internallink' || name === 'internal_link') return 32 + 72
  if (name === 'plan_md' && String(input.action ?? '').toLowerCase() === 'display') return TOOL_CARD_PLAN_MD
  if (name === 'edit_file' || name === 'editfile' || name === 'multi_edit') return TOOL_CARD_EDIT_DIFF
  if (name.startsWith('mcp__')) return TOOL_CARD_MCP_APP
  return null
}

/** Rendered height of a markdown string, counting wrapped lines and fenced code separately. */
export const estimateMarkdownHeight = (markdown: string, contentWidth: number, fontSizeOffset: number): number => {
  const text = markdown.trim()
  if (!text) return 0

  const fontSize = BASE_FONT_SIZE + fontSizeOffset
  const lineHeight = fontSize * PROSE_LINE_RATIO
  const codeLineHeight = fontSize * CODE_LINE_RATIO
  const charsPerLine = Math.max(16, Math.floor(contentWidth / (fontSize * CHAR_WIDTH_RATIO)))

  let height = 0
  let paragraphs = 0
  let inCodeFence = false
  let codeLines = 0

  const flushCodeBlock = () => {
    height += CODE_BLOCK_CHROME + Math.max(1, codeLines) * codeLineHeight
    codeLines = 0
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()

    if (line.trimStart().startsWith('```')) {
      if (inCodeFence) {
        flushCodeBlock()
        inCodeFence = false
      } else {
        inCodeFence = true
      }
      continue
    }

    if (inCodeFence) {
      codeLines += 1
      continue
    }

    if (!line.trim()) continue

    paragraphs += 1
    const wrapped = Math.max(1, Math.ceil(line.length / charsPerLine))
    // Headings render larger. h1 is 1.35em, h2 1.22em, h3 1.12em, plus mt-4 mb-2.
    const headingMatch = /^(#{1,3})\s/.exec(line.trimStart())
    if (headingMatch) {
      const scale = headingMatch[1].length === 1 ? 1.35 : headingMatch[1].length === 2 ? 1.22 : 1.12
      height += wrapped * lineHeight * scale + 24
      continue
    }
    height += wrapped * lineHeight
  }

  // An unterminated fence still renders as source while a stream is in flight.
  if (inCodeFence) flushCodeBlock()

  if (paragraphs > 1) height += (paragraphs - 1) * PARAGRAPH_GAP
  return height
}

// ── Row estimate ──────────────────────────────────────────────────────────────────────

export interface EstimateMessageRowInput {
  role: string
  /** Raw `message.content`. Used for user rows and as the no-blocks fallback. */
  content: string
  contentBlocks?: ContentBlock[]
  /** Width of the scroll container in pixels. */
  containerWidth: number
  fontSizeOffset: number
  /** `chat:groupToolReasoningRuns`. Collapses long process runs into one row. */
  groupToolReasoningRuns: boolean
  artifactCount: number
  /** Whether the row draws its actions row. Mirrors `hasContent && canBranchMessage`. */
  showsActionsRow: boolean
}

type ItemKind = 'process' | 'other'

/**
 * Estimated pixel height of one message row.
 *
 * Mirrors `renderableBlocks` and `buildContentBlockRenderItems` in `ChatMessage.tsx`:
 * tool_use and its tool_result group into one card, adjacent thinking blocks merge into
 * one reasoning row, reasoning_details draw nothing, and consecutive context_injection
 * blocks become one card.
 */
export const estimateMessageRowHeight = (input: EstimateMessageRowInput): number => {
  const {
    role,
    content,
    contentBlocks,
    containerWidth,
    fontSizeOffset,
    groupToolReasoningRuns,
    artifactCount,
    showsActionsRow,
  } = input

  const isUserRow = role === 'user'
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : []

  const contentWidth = Math.max(
    160,
    containerWidth - OUTER_INSET_X - BLOCK_INSET_X - (isUserRow ? SURFACE_INSET_X_USER : 0)
  )

  // Each entry is [height, kind]. Kind drives the process-run grouping below.
  const items: Array<[number, ItemKind]> = []

  const pushText = (markdown: string) => {
    const body = estimateMarkdownHeight(markdown, contentWidth, fontSizeOffset)
    if (body > 0) items.push([body + TEXT_BLOCK_PADDING, 'other'])
  }

  if (isUserRow) {
    // A user row draws its context injection cards, then `content` as one text block.
    let injectionRun = false
    for (const block of blocks) {
      if (block?.type === 'context_injection') {
        if (!injectionRun) {
          items.push([CONTEXT_CARD, 'other'])
          injectionRun = true
        }
      } else {
        injectionRun = false
      }
    }
    pushText(content)
  } else if (blocks.length === 0) {
    // Fallback path: an old assistant row with only a `content` string.
    pushText(content)
  } else {
    let index = 0
    while (index < blocks.length) {
      const block = blocks[index]
      if (!block) {
        index += 1
        continue
      }

      switch (block.type) {
        case 'text': {
          pushText(typeof block.content === 'string' ? block.content : '')
          break
        }
        case 'thinking': {
          // Adjacent thinking blocks merge into one reasoning row.
          const previous = blocks[index - 1]
          const mergesWithPrevious =
            previous?.type === 'thinking' ||
            (previous?.type === 'reasoning_details' && blocks[index - 2]?.type === 'thinking')
          if (!mergesWithPrevious) items.push([DISCLOSURE_ROW, 'process'])
          break
        }
        case 'tool_use': {
          items.push([estimateSpecialToolCard(block) ?? DISCLOSURE_ROW, 'process'])
          break
        }
        case 'image': {
          items.push([IMAGE_BLOCK, 'other'])
          break
        }
        case 'error': {
          items.push([ERROR_BLOCK, 'other'])
          break
        }
        case 'context_injection': {
          // Consecutive injection blocks become one card.
          if (blocks[index - 1]?.type !== 'context_injection') items.push([CONTEXT_CARD, 'other'])
          break
        }
        // tool_result folds into its tool_use group; reasoning_details draws nothing.
        case 'tool_result':
        case 'reasoning_details':
        default:
          break
      }
      index += 1
    }
  }

  if (items.length === 0) return baseChrome(isUserRow, artifactCount, showsActionsRow)

  // Long runs of process items collapse into a single "Agent steps" row. Build the list of
  // children the stack actually renders, then gap only between them.
  const children: number[] = []
  let run: number[] = []

  const flushRun = () => {
    if (run.length === 0) return
    if (groupToolReasoningRuns && run.length >= PROCESS_RUN_GROUP_MIN_ITEMS) {
      children.push(DISCLOSURE_ROW)
    } else {
      children.push(...run)
    }
    run = []
  }

  for (const [height, kind] of items) {
    if (kind === 'process') {
      run.push(height)
      continue
    }
    flushRun()
    children.push(height)
  }
  flushRun()

  const blocksHeight =
    children.reduce((total, height) => total + height, 0) + Math.max(0, children.length - 1) * STACK_GAP

  return blocksHeight + baseChrome(isUserRow, artifactCount, showsActionsRow)
}

/** Padding, caption, attachments, and actions row that sit outside the block stack. */
const baseChrome = (isUserRow: boolean, artifactCount: number, showsActionsRow: boolean): number => {
  let height = isUserRow ? OUTER_PADDING_USER + SURFACE_PADDING_USER + ROLE_CAPTION : OUTER_PADDING_OTHER
  if (artifactCount > 0) height += ATTACHMENTS_ROW
  if (showsActionsRow) height += ACTIONS_ROW
  return height
}

/** Collapsed cross-message "Agent steps" row, including its `py-1` wrapper. */
export const PROCESS_GROUP_ROW_HEIGHT = DISCLOSURE_ROW + 8
/** Stream notice, generation loader, and other small chrome rows. */
export const SMALL_CHROME_ROW_HEIGHT = NOTICE_ROW + 8
/** A transport-level failure row. */
export const CHAT_ERROR_ROW_HEIGHT = ERROR_BLOCK + 8
