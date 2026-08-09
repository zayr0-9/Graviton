/**
 * R5 — `excludeFromContext` MEANS EVERYWHERE.
 *
 * An `ErrorBlock` row ("I couldn't reach the model provider") is persisted like any
 * other message so it survives a reload and shows in the tree, but it is NOT something
 * the assistant ever said. It must therefore never reach a model, a summariser, a token
 * count, an export, or a model-callable tool.
 *
 * The server chat loop already enforces this via `excludeContextExcludedMessages` in
 * `electron/headlessServer/services/chatOrchestrator.ts`. This module is the same
 * contract, byte-for-byte, in a place the renderer, the electron main process and the
 * headless server can all import (the orchestrator's copy should delegate here — see
 * `excludeContextExcludedMessages` below).
 *
 * Semantics, identical in every consumer:
 *   - a row with NO parseable `content_blocks` is untouched (legacy/plain rows);
 *   - a row whose blocks are ALL excluded disappears entirely (the error-only row a
 *     terminal failure persists);
 *   - a mixed row keeps its non-excluded blocks, re-serialised in the shape it arrived
 *     in (string in, string out).
 */

/** The property name, kept as a constant because the cheap pre-scan below greps for it. */
const EXCLUSION_MARKER = 'excludeFromContext'

/** A single content block is excluded when it explicitly opts out. Only `ErrorBlock` does today. */
export function isContextExcludedBlock(block: unknown): boolean {
  return Boolean(block && typeof block === 'object' && (block as { excludeFromContext?: unknown }).excludeFromContext === true)
}

/** `content_blocks` is a JSON string on a DB row and an array in memory; tolerate both. */
export function parseContextBlocks(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Cheap pre-scan so the common case (no error rows anywhere) never pays for a JSON.parse
 * of every message's blocks. A serialised block set that does not contain the marker
 * substring cannot contain a block with `excludeFromContext: true`.
 */
function mayContainExclusion(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(EXCLUSION_MARKER)
  return Array.isArray(value) && value.length > 0
}

/**
 * The blocks of `value` that are still allowed in context.
 * `null` means "not a block array" — callers should treat the row as untouched.
 */
export function contextVisibleBlocks(value: unknown): { blocks: unknown[]; removed: number } | null {
  if (!mayContainExclusion(value)) {
    const asArray = parseContextBlocks(value)
    return asArray ? { blocks: asArray, removed: 0 } : null
  }
  const blocks = parseContextBlocks(value)
  if (!blocks) return null
  const visible = blocks.filter(block => !isContextExcludedBlock(block))
  return { blocks: visible, removed: blocks.length - visible.length }
}

/** Any row shape with content blocks: a DB row, a renderer `Message`, a compaction input. */
export interface ContextExcludableRow {
  content_blocks?: unknown
}

/**
 * True when the row contributes NOTHING to context: it has blocks, and every one of them
 * is excluded. This is exactly the row `excludeContextExcludedMessages` drops, and it is
 * also the row whose `content` must be ignored — an error row's `content` mirrors
 * `envelope.userMessage`, so counting or summarising it leaks the error text back in.
 */
export function isContextExcludedMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const value = (message as ContextExcludableRow).content_blocks
  if (!mayContainExclusion(value)) return false
  const visible = contextVisibleBlocks(value)
  if (!visible) return false
  return visible.blocks.length === 0 && visible.removed > 0
}

/**
 * Drop every `excludeFromContext` block before history reaches a model / summariser /
 * token count / model-callable tool.
 *
 * Rows that keep all their blocks pass through BY REFERENCE, so the non-error path is
 * untouched (identity-preserving, which several callers rely on).
 */
export function excludeContextExcludedMessages<T>(messages: readonly T[]): T[] {
  const kept: T[] = []
  for (const message of messages) {
    const raw = (message as ContextExcludableRow | null)?.content_blocks
    const visible = contextVisibleBlocks(raw)
    if (!visible || visible.removed === 0) {
      kept.push(message)
      continue
    }
    if (visible.blocks.length === 0) continue
    kept.push({
      ...(message as object),
      content_blocks: typeof raw === 'string' ? JSON.stringify(visible.blocks) : visible.blocks,
    } as T)
  }
  return kept
}
