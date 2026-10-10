import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseModel } from '../../../../shared/types'
import {
  getMarkdownFenceForText,
  handleChatToggleShortcut,
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

describe('chat-window toggle shortcuts', () => {
  const makeEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
    key: 'Tab',
    code: 'Tab',
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent)

  it.each(['composer', 'branch editor', 'chat background'])('toggles mode from %s without relying on a textarea handler', target => {
    const event = makeEvent({ target: { name: target } as unknown as EventTarget })
    const toggleOperationMode = vi.fn()
    const toggleFastServiceTier = vi.fn()

    expect(handleChatToggleShortcut(event, { toggleOperationMode, toggleFastServiceTier })).toBe(true)
    expect(toggleOperationMode).toHaveBeenCalledTimes(1)
    expect(toggleFastServiceTier).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('toggles fast mode with Ctrl+F', () => {
    const event = makeEvent({ key: 'f', code: 'KeyF', shiftKey: false, ctrlKey: true })
    const toggleOperationMode = vi.fn()
    const toggleFastServiceTier = vi.fn()

    expect(handleChatToggleShortcut(event, { toggleOperationMode, toggleFastServiceTier })).toBe(true)
    expect(toggleFastServiceTier).toHaveBeenCalledTimes(1)
    expect(toggleOperationMode).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('leaves Ctrl+F untouched when fast mode is unavailable for the provider', () => {
    const event = makeEvent({ key: 'f', code: 'KeyF', shiftKey: false, ctrlKey: true })
    expect(handleChatToggleShortcut(event, { toggleOperationMode: vi.fn() })).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it.each([
    { shiftKey: false },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { isComposing: true },
    { defaultPrevented: true },
    { key: 'f', code: 'KeyF', ctrlKey: true },
    { key: 'f', code: 'KeyF', shiftKey: false, metaKey: true },
    { key: 'f', code: 'KeyF', shiftKey: false, ctrlKey: true, altKey: true },
  ])('ignores unrelated or already consumed chords: %j', overrides => {
    const event = makeEvent(overrides)
    const toggleOperationMode = vi.fn()
    const toggleFastServiceTier = vi.fn()
    expect(handleChatToggleShortcut(event, { toggleOperationMode, toggleFastServiceTier })).toBe(false)
    expect(toggleOperationMode).not.toHaveBeenCalled()
    expect(toggleFastServiceTier).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { key: 'f', code: 'KeyF', shiftKey: false, ctrlKey: true },
  ])('consumes held shortcuts without toggling repeatedly: %j', overrides => {
    const event = makeEvent({ ...overrides, repeat: true })
    const toggleOperationMode = vi.fn()
    const toggleFastServiceTier = vi.fn()
    expect(handleChatToggleShortcut(event, { toggleOperationMode, toggleFastServiceTier })).toBe(true)
    expect(toggleOperationMode).not.toHaveBeenCalled()
    expect(toggleFastServiceTier).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
  })
})
