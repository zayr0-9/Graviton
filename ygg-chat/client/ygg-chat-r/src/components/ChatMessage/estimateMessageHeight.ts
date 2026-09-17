import type { ContentBlock } from '@/features/chats/chatTypes'
import { buildMcpAppEntryKey, getMcpAppHeight } from '../McpAppIframe/mcpAppSizing'
import { isProcessOnlyBlockSet, PROCESS_RUN_GROUP_MIN_ITEMS } from './chatMessageShared'

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
//
// Tailwind spacing and sizing utilities are rem based, and index.css scales the ROOT font size
// by display density: 16px normally, 15px above 144dpi, 14px on a 2x retina panel, back to 16px
// on a very large high-dpi screen. A retina laptop therefore renders `h-8` at 28px, not 32px.
// Constants below are held in rem and resolved against the measured root size, so the estimate
// does not carry a systematic 12.5% error on the display most of this app runs on.
//
// Values written in px are genuinely px in the markup: Tailwind's `px` suffix, inline `height`
// styles such as the MCP app iframe, and rough guesses for content whose real height is unknown.

/** `MESSAGE_BLOCK_STACK_CLASS` gap-1.5. */
const REM_STACK_GAP = 0.375
/** Text block `py-1`, both sides. */
const REM_TEXT_BLOCK_PADDING = 0.5
/** `DISCLOSURE_ROW_CLASS` h-8. Collapsed reasoning, tool card, and agent-steps rows. */
const REM_DISCLOSURE_ROW = 2
/** Image block `py-1`, both sides. */
const REM_IMAGE_PADDING = 0.5
/** `ContextInjectionCard` collapsed header: `py-2.5` around an 18px icon row. */
const REM_CONTEXT_CARD = 1.25
/** Outer wrapper `pt-3 pb-1` on user rows, `py-1` on ordinary rows. */
const REM_OUTER_PADDING_USER = 1
const REM_OUTER_PADDING_OTHER = 0.5
/** Tinted surface on user rows: `pt-2 pb-1` and `px-1.5`. */
const REM_SURFACE_PADDING_USER = 0.75
const REM_SURFACE_INSET_X_USER = 0.75
/** Role caption row `h-7`. */
const REM_ROLE_CAPTION = 1.75
/** Actions row `h-10`. */
const REM_ACTIONS_ROW = 2.5
/** Attachment strip: `py-2` plus one `h-20` tile row. */
const REM_ATTACHMENTS_ROW = 5.5
/** Horizontal chrome: outer `sm:px-2` both sides, then block inset `px-2.5` both sides. */
const REM_OUTER_INSET_X = 1
const REM_BLOCK_INSET_X = 1.25
/** Fenced code block: `h-8` header, `py-2.5` body padding, `prose-pre:my-3` both sides. */
const REM_CODE_BLOCK_CHROME = 4.75

/**
 * Outer wrapper `py-px` on a process-only row. Tailwind's `px` suffix is a literal 1px, so this
 * does not scale with the root size.
 */
const OUTER_PADDING_PROCESS_ONLY = 2
/**
 * Effective gap between two consecutive process blocks, meaning tool cards and reasoning rows.
 * `[data-chat-block] + [data-chat-block]` in index.css pulls the stack gap back to exactly this
 * many px, and a process-only message row carries `py-px` on each side so two such rows leave
 * the same 2px. A run of agent work therefore spaces evenly whether two blocks share a message
 * or straddle a message boundary. Keep all three in step.
 */
const PROCESS_RUN_GAP = 2
/** `ChatErrorBubble` with one line of text and no expanded detail. */
const ERROR_BLOCK = 110
/** A contained image. `max-h-96` caps the real one at 24rem. */
const IMAGE_CONTENT = 280

/**
 * Prose is sized by arbitrary px utilities (`sm:text-[14px]`), not rem, so it does not follow
 * the root size.
 */
const BASE_FONT_SIZE = 14
/** `leading-[1.55]` on prose. */
const PROSE_LINE_RATIO = 1.55
/** `prose-p:my-1.5`, collapsed between siblings. */
const PARAGRAPH_GAP = 6
/** Mean glyph advance for the app font at 14px. Measured by eye against real transcripts. */
const CHAR_WIDTH_RATIO = 0.515
/** Code is rendered at `text-[0.85em]` with `leading-[1.5]`. */
const CODE_LINE_RATIO = 0.85 * 1.5

/** Body height of an always-expanded tool card, in px. The header is a separate rem value. */
const TOOL_BODY_EDIT_DIFF = 96
const TOOL_BODY_PLAN_MD = 200
const TOOL_BODY_HTML = 400
const TOOL_BODY_INTERNAL_LINK = 72
/** `DISCLOSURE_BODY_CLASS` (pt-1 pb-2) plus the `p-1` surface card around the MCP iframe. */
const REM_MCP_APP_BODY_CHROME = 1.25

/** The root font size when it cannot be measured, matching the index.css default. */
export const DEFAULT_ROOT_FONT_SIZE = 16

// ── Text measurement ──────────────────────────────────────────────────────────────────

/** Tool names vary by provider in case and separator, so compare on a normalized form. */
const normalizeToolName = (name: unknown): string =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[-\s]/g, '_')

/**
 * Height of one always-expanded tool card, or null when the tool draws the ordinary
 * collapsible row. Mirrors the variant branches in `ToolCallGroupCard`.
 */
const estimateSpecialToolCard = (
  block: Extract<ContentBlock, { type: 'tool_use' }>,
  rootFontSize: number,
  messageId: string | undefined,
  isMcpAppTool: ((toolName: string) => boolean) | undefined
): number | null => {
  const name = normalizeToolName(block.name)
  const input = (block.input ?? {}) as Record<string, unknown>
  const header = REM_DISCLOSURE_ROW * rootFontSize

  if (name === 'html_renderer' && typeof input.html === 'string') return header + TOOL_BODY_HTML
  if (name === 'internallink' || name === 'internal_link') return header + TOOL_BODY_INTERNAL_LINK
  if (name === 'plan_md' && String(input.action ?? '').toLowerCase() === 'display') return header + TOOL_BODY_PLAN_MD
  if (name === 'edit_file' || name === 'editfile' || name === 'multi_edit') return header + TOOL_BODY_EDIT_DIFF
  if (name.startsWith('mcp__')) {
    // Only MCP tools with a UI resource draw the always-open app card. The rest are ordinary
    // collapsible rows. Without the predicate, assume the app: that was the old behaviour.
    if (isMcpAppTool && !isMcpAppTool(String(block.name ?? ''))) return null
    const key = messageId && block.id ? buildMcpAppEntryKey(messageId, block.id) : null
    return header + REM_MCP_APP_BODY_CHROME * rootFontSize + getMcpAppHeight(key)
  }
  return null
}

/** Rendered height of a markdown string, counting wrapped lines and fenced code separately. */
export const estimateMarkdownHeight = (
  markdown: string,
  contentWidth: number,
  fontSizeOffset: number,
  rootFontSize: number
): number => {
  const text = markdown.trim()
  if (!text) return 0

  const fontSize = BASE_FONT_SIZE + fontSizeOffset
  const lineHeight = fontSize * PROSE_LINE_RATIO
  const codeLineHeight = fontSize * CODE_LINE_RATIO
  const codeBlockChrome = REM_CODE_BLOCK_CHROME * rootFontSize
  const charsPerLine = Math.max(16, Math.floor(contentWidth / (fontSize * CHAR_WIDTH_RATIO)))

  let height = 0
  let paragraphs = 0
  let inCodeFence = false
  let codeLines = 0

  const flushCodeBlock = () => {
    height += codeBlockChrome + Math.max(1, codeLines) * codeLineHeight
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
  /** Computed font size of the root element, which every rem utility scales from. */
  rootFontSize: number
  fontSizeOffset: number
  /** `chat:groupToolReasoningRuns`. Collapses long process runs into one row. */
  groupToolReasoningRuns: boolean
  artifactCount: number
  /** Whether the row draws its actions row. Mirrors `hasContent && canBranchMessage`. */
  showsActionsRow: boolean
  /** Lets MCP app cards look up their remembered height. Omit for rows without a persisted id. */
  messageId?: string
  /** True when the MCP tool has a UI resource and so draws the always-open app card. */
  isMcpAppTool?: (toolName: string) => boolean
  /** Collapsed Hook Activity card rendered after assistant content. */
  hookRunCount?: number
}

type ItemKind = 'tool' | 'reasoning' | 'other'

/**
 * Estimated pixel height of one message row.
 *
 * Mirrors `renderableBlocks` and `buildContentBlockRenderItems` in `ChatMessage.tsx`:
 * tool_use and its tool_result group into one card, adjacent thinking blocks merge into
 * one reasoning row, consecutive context_injection blocks become one card, and any block the
 * renderer draws nothing for contributes nothing here.
 */
export const estimateMessageRowHeight = (input: EstimateMessageRowInput): number => {
  const {
    role,
    content,
    contentBlocks,
    containerWidth,
    rootFontSize,
    fontSizeOffset,
    groupToolReasoningRuns,
    artifactCount,
    showsActionsRow,
    messageId,
    isMcpAppTool,
    hookRunCount = 0,
  } = input

  const isUserRow = role === 'user'
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : []
  // Mirrors `isProcessOnlyRow` in ChatMessage, which drops such a row to `py-px`.
  const isProcessOnly = !isUserRow && isProcessOnlyBlockSet(contentBlocks)

  const disclosureRow = REM_DISCLOSURE_ROW * rootFontSize
  const textBlockPadding = REM_TEXT_BLOCK_PADDING * rootFontSize
  const imageBlock = REM_IMAGE_PADDING * rootFontSize + IMAGE_CONTENT
  const contextCard = REM_CONTEXT_CARD * rootFontSize + 18
  const stackGap = REM_STACK_GAP * rootFontSize

  const contentWidth = Math.max(
    160,
    containerWidth -
      REM_OUTER_INSET_X * rootFontSize -
      REM_BLOCK_INSET_X * rootFontSize -
      (isUserRow ? REM_SURFACE_INSET_X_USER * rootFontSize : 0)
  )

  // Each entry is [height, kind]. Kind drives the run grouping and the tighter run gap.
  const items: Array<[number, ItemKind]> = []
  const isProcessKind = (kind: ItemKind) => kind === 'tool' || kind === 'reasoning'

  const pushText = (markdown: string) => {
    const body = estimateMarkdownHeight(markdown, contentWidth, fontSizeOffset, rootFontSize)
    if (body > 0) items.push([body + textBlockPadding, 'other'])
  }

  if (isUserRow) {
    // A user row draws its context injection cards, then `content` as one text block.
    let injectionRun = false
    for (const block of blocks) {
      if (block?.type === 'context_injection') {
        if (!injectionRun) {
          items.push([contextCard, 'other'])
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
          if (!mergesWithPrevious) items.push([disclosureRow, 'reasoning'])
          break
        }
        case 'tool_use': {
          items.push([estimateSpecialToolCard(block, rootFontSize, messageId, isMcpAppTool) ?? disclosureRow, 'tool'])
          break
        }
        case 'image': {
          items.push([imageBlock, 'other'])
          break
        }
        case 'error': {
          items.push([ERROR_BLOCK, 'other'])
          break
        }
        case 'context_injection': {
          // Consecutive injection blocks become one card.
          if (blocks[index - 1]?.type !== 'context_injection') items.push([contextCard, 'other'])
          break
        }
        // tool_result folds into its tool_use group. reasoning_details, provider bookkeeping
        // such as openai_context_usage, and any unknown type draw nothing.
        default:
          break
      }
      index += 1
    }
  }

  if (!isUserRow && hookRunCount > 0) items.push([REM_CONTEXT_CARD * rootFontSize, 'other'])
  if (items.length === 0) return baseChrome(isUserRow, artifactCount, showsActionsRow, isProcessOnly, rootFontSize)

  // Long runs of process items collapse into a single "Agent steps" row. Build the list of
  // children the stack actually renders, then gap only between them.
  const children: Array<[number, ItemKind]> = []
  let run: Array<[number, ItemKind]> = []

  const flushRun = () => {
    if (run.length === 0) return
    if (groupToolReasoningRuns && run.length >= PROCESS_RUN_GROUP_MIN_ITEMS) {
      // The collapsed "Agent steps" row is a disclosure row, not a process card, so it does not
      // take the tighter run gap.
      children.push([disclosureRow, 'other'])
    } else {
      children.push(...run)
    }
    run = []
  }

  for (const item of items) {
    if (isProcessKind(item[1])) {
      run.push(item)
      continue
    }
    flushRun()
    children.push(item)
  }
  flushRun()

  let blocksHeight = 0
  for (let index = 0; index < children.length; index += 1) {
    blocksHeight += children[index][0]
    if (index === 0) continue
    const bothAreProcessBlocks = isProcessKind(children[index][1]) && isProcessKind(children[index - 1][1])
    blocksHeight += bothAreProcessBlocks ? PROCESS_RUN_GAP : stackGap
  }

  return blocksHeight + baseChrome(isUserRow, artifactCount, showsActionsRow, isProcessOnly, rootFontSize)
}

/** Padding, caption, attachments, and actions row that sit outside the block stack. */
const baseChrome = (
  isUserRow: boolean,
  artifactCount: number,
  showsActionsRow: boolean,
  isProcessOnly: boolean,
  rootFontSize: number
): number => {
  let height = isUserRow
    ? (REM_OUTER_PADDING_USER + REM_SURFACE_PADDING_USER + REM_ROLE_CAPTION) * rootFontSize
    : isProcessOnly
      ? OUTER_PADDING_PROCESS_ONLY
      : REM_OUTER_PADDING_OTHER * rootFontSize
  if (artifactCount > 0) height += REM_ATTACHMENTS_ROW * rootFontSize
  if (showsActionsRow) height += REM_ACTIONS_ROW * rootFontSize
  return height
}

/** Collapsed cross-message "Agent steps" row, including its `py-1` wrapper. */
export const processGroupRowHeight = (rootFontSize: number): number =>
  (REM_DISCLOSURE_ROW + REM_OUTER_PADDING_OTHER) * rootFontSize
/** Stream notice, generation loader, and other small chrome rows. */
export const smallChromeRowHeight = (rootFontSize: number): number =>
  (REM_DISCLOSURE_ROW + REM_OUTER_PADDING_OTHER) * rootFontSize
/** A transport-level failure row. */
export const chatErrorRowHeight = (rootFontSize: number): number =>
  ERROR_BLOCK + REM_OUTER_PADDING_OTHER * rootFontSize
