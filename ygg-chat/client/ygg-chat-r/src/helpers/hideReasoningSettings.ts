import { useSyncExternalStore } from 'react'
import type { ContentBlock, StreamEvent } from '../features/chats/chatTypes'

export const HIDE_REASONING_BLOCKS_KEY = 'chat:hideReasoningBlocks'
const CHANGE_EVENT = 'hideReasoningBlocksChange'

export function loadHideReasoningBlocks(): boolean {
  try {
    return localStorage.getItem(HIDE_REASONING_BLOCKS_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveHideReasoningBlocks(enabled: boolean): void {
  try {
    localStorage.setItem(HIDE_REASONING_BLOCKS_KEY, String(enabled))
  } catch { /* Keep storage failures non-fatal, like other chat appearance settings. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === HIDE_REASONING_BLOCKS_KEY || event.key === null) onChange()
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Off by default: reasoning stays visible until the user hides it in Chat Settings. */
export function useHideReasoningBlocks(): boolean {
  return useSyncExternalStore(subscribe, loadHideReasoningBlocks, loadHideReasoningBlocks)
}

const isReasoningResponsesItem = (item: unknown): boolean =>
  Boolean(item) && typeof item === 'object' && (item as { type?: unknown }).type === 'reasoning'

const responsesItemsOf = (block: ContentBlock): unknown[] | null => {
  const record = block as unknown as { type?: unknown; items?: unknown }
  return record.type === 'responses_output_items' && Array.isArray(record.items) ? record.items : null
}

export const isReasoningBlock = (block: ContentBlock | null | undefined): boolean =>
  block?.type === 'thinking' || block?.type === 'reasoning_details'

export function hasReasoningContent(blocks: ContentBlock[] | undefined): boolean {
  return Boolean(blocks?.some(block => isReasoningBlock(block) || responsesItemsOf(block)?.some(isReasoningResponsesItem)))
}

/**
 * The display view of a message with its reasoning removed. Hiding is presentation only: callers
 * keep the original blocks for editing, so an edited assistant message still round-trips its thinking.
 * Returns the same array when there is nothing to remove.
 */
export function withoutReasoningBlocks(blocks: ContentBlock[] | undefined): ContentBlock[] | undefined {
  if (!blocks || !hasReasoningContent(blocks)) return blocks
  const visible: ContentBlock[] = []
  for (const block of blocks) {
    if (isReasoningBlock(block)) continue
    const items = responsesItemsOf(block)
    visible.push(items ? ({ ...block, items: items.filter(item => !isReasoningResponsesItem(item)) } as unknown as ContentBlock) : block)
  }
  return visible
}

export function withoutReasoningEvents(events: StreamEvent[]): StreamEvent[] {
  return events.some(event => event.type === 'reasoning') ? events.filter(event => event.type !== 'reasoning') : events
}
