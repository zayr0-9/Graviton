import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from './commandRegistry'
import { formatShortcut } from './commands'

const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  repeat: false, isComposing: false, defaultPrevented: false,
  preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
} as unknown as KeyboardEvent)

const context = { mac: false, editable: false }

describe('shared command routing', () => {
  it.each([
    [false, { altKey: true }, true],
    [true, { key: '[', metaKey: true }, true],
    [true, { altKey: true }, false],
    [false, { key: '[', ctrlKey: true }, false],
    [false, { altKey: true, shiftKey: true }, false],
    [true, { key: '[', metaKey: true, ctrlKey: true }, false],
  ])('matches exact navigation modifiers (mac=%s, %j)', (mac, overrides, handled) => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register({ id: 'navigation.back', run })
    const event = key(overrides)
    expect(registry.dispatch(event, { ...context, mac, editable: true })).toBe(handled)
    expect(run).toHaveBeenCalledTimes(handled ? 1 : 0)
    expect(event.preventDefault).toHaveBeenCalledTimes(handled ? 1 : 0)
  })

  it.each([{ defaultPrevented: true }, { isComposing: true }])('ignores consumed/composing events %j', overrides => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register({ id: 'navigation.back', run })
    expect(registry.dispatch(key({ altKey: true, ...overrides }), context)).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('unregisters handlers and uses live availability', () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    let enabled = false
    const unregister = registry.register({ id: 'navigation.back', run, enabled: () => enabled })
    expect(registry.dispatch(key({ altKey: true }), context)).toBe(false)
    enabled = true
    expect(registry.dispatch(key({ altKey: true }), context)).toBe(true)
    unregister()
    expect(registry.dispatch(key({ altKey: true }), context)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('routes graph keys only to the directly focused widget, never its inputs/buttons', () => {
    const registry = new CommandRegistry()
    const graph = {} as Element
    const run = vi.fn()
    registry.register({ id: 'heimdall.parent', scope: () => graph, run })
    expect(registry.dispatch(key({ key: 'ArrowUp', target: {} as EventTarget }), context)).toBe(false)
    expect(registry.dispatch(key({ key: 'ArrowUp', target: graph }), { ...context, editable: true })).toBe(false)
    expect(registry.dispatch(key({ key: 'ArrowUp', target: graph }), context)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('allows repeated cursor movement but consumes repeated activations and history jumps without executing', () => {
    const registry = new CommandRegistry()
    const activate = vi.fn()
    const move = vi.fn()
    const back = vi.fn()
    registry.register({ id: 'heimdall.activate', run: activate })
    registry.register({ id: 'heimdall.parent', run: move })
    registry.register({ id: 'navigation.back', run: back })
    expect(registry.dispatch(key({ key: 'Enter', repeat: true }), context)).toBe(true)
    expect(registry.dispatch(key({ key: 'ArrowUp', repeat: true }), context)).toBe(true)
    expect(registry.dispatch(key({ altKey: true, repeat: true }), context)).toBe(true)
    expect(activate).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('blocks background commands for semantic and nested legacy overlays', () => {
    const registry = new CommandRegistry()
    registry.register({ id: 'navigation.back', run: vi.fn() })
    const closeFirst = registry.block()
    const closeSecond = registry.block()
    closeFirst()
    expect(registry.dispatch(key({ altKey: true }), context)).toBe(false)
    closeSecond()
    expect(registry.dispatch(key({ altKey: true }), { ...context, blocked: true })).toBe(false)
    expect(registry.dispatch(key({ altKey: true }), context)).toBe(true)
  })

  it('prioritizes focused widget commands over application commands', () => {
    const registry = new CommandRegistry()
    const graph = {} as Element
    const globalRun = vi.fn()
    const widgetRun = vi.fn()
    registry.register({ id: 'heimdall.activate', run: globalRun })
    registry.register({ id: 'heimdall.activate', scope: () => graph, run: widgetRun })
    registry.dispatch(key({ key: 'Enter', target: graph }), context)
    expect(widgetRun).toHaveBeenCalledTimes(1)
    expect(globalRun).not.toHaveBeenCalled()
  })

  it('uses saved bindings immediately and does not run disabled commands', () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register({ id: 'navigation.back', run })
    const configured = { ...context, overrides: { 'navigation.back': [{ key: 'k', primary: true, shift: true }] } }
    expect(registry.dispatch(key({ altKey: true }), configured)).toBe(false)
    expect(registry.dispatch(key({ key: 'K', ctrlKey: true, shiftKey: true }), configured)).toBe(true)
    expect(registry.dispatch(key({ altKey: true }), { ...context, overrides: { 'navigation.back': [] } })).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('formats tooltips from the same platform bindings', () => {
    expect(formatShortcut('navigation.back', true)).toBe('⌘ [')
    expect(formatShortcut('navigation.forward', false)).toBe('Alt+→')
    expect(formatShortcut('heimdall.focus', false)).toBe('Ctrl+Shift+E')
  })
})
