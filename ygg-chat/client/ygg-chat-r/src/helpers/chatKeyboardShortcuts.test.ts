import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseModel } from '../../../../shared/types'
import {
  getMarkdownFenceForText,
  loadModelShortcutSlots,
  MODEL_SHORTCUT_SLOTS_STORAGE_KEY,
  saveModelShortcutSlot,
  wrapPastedTextInMarkdownFence,
} from './chatKeyboardShortcuts'

const model = { name: 'test/model', displayName: 'Test Model' } as BaseModel

describe('chat keyboard shortcuts', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
      dispatchEvent: vi.fn(),
    })
  })

  it('persists provider-aware model slots and can clear them', () => {
    saveModelShortcutSlot(3, { provider: 'OpenRouter', model })
    expect(loadModelShortcutSlots()[3]).toEqual({ provider: 'OpenRouter', model })

    saveModelShortcutSlot(3, null)
    expect(loadModelShortcutSlots()[3]).toBeUndefined()
  })

  it('ignores invalid slot records', () => {
    window.localStorage.setItem(
      MODEL_SHORTCUT_SLOTS_STORAGE_KEY,
      JSON.stringify({ 1: { provider: '', model }, 2: { provider: 'OpenRouter', model: {} } })
    )

    expect(loadModelShortcutSlots()).toEqual({})
  })

  it('wraps pasted text in a fence longer than any nested backtick run', () => {
    expect(getMarkdownFenceForText('const ok = true')).toBe('```')
    expect(wrapPastedTextInMarkdownFence('a ``` nested')).toBe('````\na ``` nested\n````')
  })
})
