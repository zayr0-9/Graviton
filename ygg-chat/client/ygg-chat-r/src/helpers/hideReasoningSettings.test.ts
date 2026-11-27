import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, StreamEvent } from '../features/chats/chatTypes'
import {
  HIDE_REASONING_BLOCKS_KEY,
  hasReasoningContent,
  loadHideReasoningBlocks,
  saveHideReasoningBlocks,
  withoutReasoningBlocks,
  withoutReasoningEvents,
} from './hideReasoningSettings'

const responses = (items: unknown[]) => ({ type: 'responses_output_items', index: 2, items }) as unknown as ContentBlock

describe('hide reasoning setting', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is off by default and persists both directions', () => {
    expect(loadHideReasoningBlocks()).toBe(false)
    saveHideReasoningBlocks(true)
    expect(localStorage.getItem(HIDE_REASONING_BLOCKS_KEY)).toBe('true')
    expect(loadHideReasoningBlocks()).toBe(true)
    saveHideReasoningBlocks(false)
    expect(loadHideReasoningBlocks()).toBe(false)
  })
})

describe('withoutReasoningBlocks', () => {
  it('returns the same array when there is no reasoning', () => {
    const blocks: ContentBlock[] = [{ type: 'text', index: 0, content: 'Answer' }]
    expect(hasReasoningContent(blocks)).toBe(false)
    expect(withoutReasoningBlocks(blocks)).toBe(blocks)
    expect(withoutReasoningBlocks(undefined)).toBeUndefined()
  })

  it('removes thinking, reasoning details and Responses reasoning items without mutating the input', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', index: 0, content: 'Plan' },
      { type: 'tool_use', index: 1, id: 't1', name: 'read_file', input: {} },
      responses([{ type: 'reasoning', summary: [{ text: 'Why' }] }, { type: 'message', role: 'assistant', content: [] }]),
      { type: 'reasoning_details', index: 3 } as unknown as ContentBlock,
      { type: 'text', index: 4, content: 'Answer' },
    ]
    expect(hasReasoningContent(blocks)).toBe(true)
    const visible = withoutReasoningBlocks(blocks)!
    expect(visible.map(block => block.type)).toEqual(['tool_use', 'responses_output_items', 'text'])
    expect((visible[1] as unknown as { items: Array<{ type: string }> }).items.map(item => item.type)).toEqual(['message'])
    expect(blocks).toHaveLength(5)
    expect((blocks[2] as unknown as { items: unknown[] }).items).toHaveLength(2)
  })
})

describe('withoutReasoningEvents', () => {
  it('drops reasoning deltas and keeps identity when there are none', () => {
    const plain: StreamEvent[] = [{ type: 'text', delta: 'Hi' } as StreamEvent]
    expect(withoutReasoningEvents(plain)).toBe(plain)
    const mixed = [{ type: 'reasoning', delta: 'Plan' }, ...plain] as StreamEvent[]
    expect(withoutReasoningEvents(mixed)).toEqual(plain)
  })
})
