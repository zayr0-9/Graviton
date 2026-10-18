import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureShortcut, findShortcutConflict, loadShortcutOverrides, parseShortcutOverrides, saveShortcutOverrides, SHORTCUT_CHANGE_EVENT, SHORTCUT_STORAGE_KEY, subscribeShortcutOverrides } from './shortcutPreferences'
import { formatShortcut, getBindings, matchesBinding } from './commands'

const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 'k', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  isComposing: false, repeat: false, ...overrides,
} as KeyboardEvent)

afterEach(() => vi.unstubAllGlobals())

describe('shortcut preferences', () => {
  it('loads known valid overrides, preserves disabled commands, and drops invalid values', () => {
    expect(parseShortcutOverrides(JSON.stringify({
      'navigation.back': [{ key: 'k', primary: true, shift: true }],
      'navigation.forward': [],
      'heimdall.parent': [{ key: 'Shift' }],
      'heimdall.child': [{ key: 'j', alt: 'true' }],
      unknown: [{ key: 'x' }],
    }))).toEqual({
      'navigation.back': [{ key: 'k', primary: true, shift: true }],
      'navigation.forward': [],
    })
    expect(parseShortcutOverrides('{broken')).toEqual({})
    expect(parseShortcutOverrides('[]')).toEqual({})
    expect(parseShortcutOverrides(null)).toEqual({})
  })

  it('falls back safely on unavailable storage and surfaces write failures', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('Denied') }, setItem: () => { throw new Error('Denied') } } })
    expect(loadShortcutOverrides()).toEqual({})
    expect(() => saveShortcutOverrides({})).toThrow('Denied')
  })

  it('persists and announces same-window changes, and subscribes only to relevant storage events', () => {
    const target = new EventTarget()
    const store = new Map<string, string>()
    vi.stubGlobal('window', Object.assign(target, {
      localStorage: { getItem: (name: string) => store.get(name) ?? null, setItem: (name: string, value: string) => store.set(name, value) },
    }))
    const listener = vi.fn()
    const dispose = subscribeShortcutOverrides(listener)
    saveShortcutOverrides({ 'navigation.back': [] })
    expect(loadShortcutOverrides()).toEqual({ 'navigation.back': [] })
    expect(listener).toHaveBeenCalledTimes(1)
    for (const name of ['unrelated', SHORTCUT_STORAGE_KEY, null]) {
      const event = new Event('storage')
      Object.defineProperty(event, 'key', { value: name })
      target.dispatchEvent(event)
    }
    expect(listener).toHaveBeenCalledTimes(3)
    dispose()
    target.dispatchEvent(new Event(SHORTCUT_CHANGE_EVENT))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('uses overrides for matching and display while reset restores platform defaults', () => {
    const overrides = { 'navigation.back': [{ key: 'k', primary: true, shift: true }] }
    expect(formatShortcut('navigation.back', true, overrides)).toBe('⌘ ⇧ K')
    expect(matchesBinding(key({ key: 'K', metaKey: true, shiftKey: true }), getBindings('navigation.back', true, overrides)[0], true)).toBe(true)
    expect(getBindings('navigation.back', true, {})).toEqual([{ key: '[', primary: true }])
    expect(formatShortcut('navigation.back', true, { 'navigation.back': [] })).toBe('Not assigned')
  })

  it('records primary modifiers portably while retaining secondary modifiers', () => {
    expect(captureShortcut(key({ key: 'K', metaKey: true, ctrlKey: true, shiftKey: true }), 'navigation.back', true).binding)
      .toEqual({ key: 'K', primary: true, ctrl: true, shift: true })
    expect(captureShortcut(key({ key: 'h' }), 'heimdall.parent', false).binding).toEqual({ key: 'h', primary: false })
  })

  it.each(['Shift', 'Control', 'Meta', 'Alt', 'Tab', 'Escape'])('does not record %s', value => {
    expect(captureShortcut(key({ key: value }), 'heimdall.parent', false)).toEqual({})
  })

  it('ignores repeats/composition and protects plain typing for app-wide commands', () => {
    expect(captureShortcut(key({ repeat: true }), 'heimdall.parent', false)).toEqual({})
    expect(captureShortcut(key({ isComposing: true }), 'heimdall.parent', false)).toEqual({})
    expect(captureShortcut(key(), 'navigation.back', false).error).toBeTruthy()
    expect(captureShortcut(key({ key: 'ArrowLeft', altKey: true }), 'navigation.back', false).binding).toBeTruthy()
  })

  it.each([
    { key: 'f', ctrlKey: true }, { key: ',', ctrlKey: true }, { key: '2', ctrlKey: true },
    { key: 'w', ctrlKey: true }, { key: 'v', ctrlKey: true },
  ])('rejects existing Chat and standard shortcuts %j', value => {
    expect(captureShortcut(key(value), 'heimdall.parent', false).error).toBeTruthy()
  })

  it('reserves both Ctrl and Meta Chat chords regardless of the platform primary modifier', () => {
    expect(captureShortcut(key({ key: ',', code: 'Comma', ctrlKey: true }), 'heimdall.parent', true).error).toBeTruthy()
    expect(captureShortcut(key({ key: '1', code: 'Digit1', metaKey: true }), 'heimdall.parent', false).error).toBeTruthy()
    expect(captureShortcut(key({ key: 'u', code: 'KeyF', ctrlKey: true }), 'heimdall.parent', true).error).toBeTruthy()
  })

  it('finds conflicts against defaults and edited values and permits cleared keys', () => {
    expect(findShortcutConflict('heimdall.parent', { key: 'ArrowRight' }, {}, false)).toBe('heimdall.nextSibling')
    expect(findShortcutConflict('heimdall.parent', { key: 'K', primary: true }, { 'navigation.back': [{ key: 'k', ctrl: true }] }, false)).toBe('navigation.back')
    expect(findShortcutConflict('heimdall.parent', { key: 'ArrowRight' }, { 'heimdall.nextSibling': [] }, false)).toBeUndefined()
  })
})
