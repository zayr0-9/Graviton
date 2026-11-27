import { extractHtmlFromToolResult } from '../../../../../shared/toolResultHtml.js'

/**
 * Compacts the content blocks of a message that is on the selected branch but outside the
 * renderer's initial window. The row keeps its topology, prose, usage, thinking preview and
 * every small scalar (file paths, commands, ids, short results), so process grouping, todo and
 * workspace tracking and the context meter see the same shape before and after hydration.
 * Only large payloads (tool output, big tool inputs, provider output items) are dropped; the
 * renderer fetches them with /messages/bodies when the row scrolls into view.
 */

/** Scalars up to this length survive compaction. */
const SMALL_SCALAR_CHARS = 512
/** A compacted thinking block keeps this much so "has reasoning" semantics do not change. */
const THINKING_PREVIEW_CHARS = 160
/** Block types that are never compacted: they are what the transcript shows at a glance. */
const KEEP_WHOLE = new Set(['text', 'context_injection', 'context_usage', 'error'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isSmallScalar = (value: unknown): boolean =>
  typeof value === 'string' ? value.length <= SMALL_SCALAR_CHARS : value === null || typeof value !== 'object'

const serializedLength = (value: unknown): number => {
  try { return JSON.stringify(value)?.length ?? 0 } catch { return 0 }
}

export interface CompactedMessageBody {
  content_blocks: unknown[]
  /** Serialised characters removed; the renderer adds them to its context estimate. */
  omittedChars: number
}

/** Returns `null` when nothing is large enough to drop, so the row ships (and is flagged) as is. */
export function compactMessageBody(blocks: unknown): CompactedMessageBody | null {
  if (!Array.isArray(blocks)) return null
  let omittedChars = 0
  let changed = false
  const content_blocks = blocks.map(block => {
    if (!isRecord(block) || (typeof block.type === 'string' && KEEP_WHOLE.has(block.type))) return block
    if (block.type === 'thinking') {
      if (typeof block.content !== 'string' || block.content.length <= THINKING_PREVIEW_CHARS) return block
      omittedChars += block.content.length - THINKING_PREVIEW_CHARS
      changed = true
      return { ...block, content: block.content.slice(0, THINKING_PREVIEW_CHARS), omitted: true }
    }
    const out: Record<string, unknown> = {}
    let dropped = false
    for (const [key, value] of Object.entries(block)) {
      if (key === 'input' && isRecord(value)) {
        const input: Record<string, unknown> = {}
        for (const [name, field] of Object.entries(value)) {
          if (isSmallScalar(field)) input[name] = field
          else { dropped = true; omittedChars += serializedLength(field) }
        }
        out.input = input
        continue
      }
      if (isSmallScalar(value)) out[key] = value
      else { dropped = true; omittedChars += serializedLength(value) }
    }
    if (!dropped) return block
    if (block.type === 'tool_result' && !('content' in out) && extractHtmlFromToolResult(block.content)) {
      out.html_omitted = true
    }
    changed = true
    return { ...out, omitted: true }
  })
  return changed ? { content_blocks, omittedChars } : null
}
