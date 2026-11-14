import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isTouchContextMenu,
  placeTouchSelectionMenu,
  readSelectionInside,
  startTouchSelectionSession,
  TOUCH_SELECTION_DELAYS,
  type SettledSelection,
  type TouchSelectionEventTarget,
} from './touchSelectionMenu'

class FakeDocument implements TouchSelectionEventTarget {
  listeners = new Map<string, Set<(event: any) => void>>()
  addEventListener(type: string, listener: (event: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  count() {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0)
  }
}

const SELECTION: SettledSelection = { text: 'picked words', rect: { top: 300, bottom: 340, left: 40, right: 260 } }
const MENU = { tag: 'menu' }

function setup(initialTouch = true) {
  const doc = new FakeDocument()
  let current: SettledSelection | null = SELECTION
  const onShow = vi.fn()
  const onHide = vi.fn()
  const onRelease = vi.fn()
  const stop = startTouchSelectionSession(
    {
      target: doc,
      readSelection: () => current,
      isInsideMenu: target => target === MENU,
      onShow,
      onHide,
      onRelease,
    },
    initialTouch
  )
  return { doc, onShow, onHide, onRelease, stop, setSelection: (next: SettledSelection | null) => { current = next } }
}

describe('touch selection session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for the long-press finger to lift before showing the menu', () => {
    const { doc, onShow } = setup()
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.afterRelease + 50)
    expect(onShow).not.toHaveBeenCalled()

    doc.emit('touchend', { touches: { length: 0 } })
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.afterRelease)
    expect(onShow).toHaveBeenCalledWith(SELECTION)
  })

  it('stays hidden while the selection keeps changing during a drag', () => {
    const { doc, onShow, onHide } = setup()
    // The browser cancels the page touch when the long-press becomes a selection drag.
    doc.emit('touchcancel', { touches: { length: 0 } })
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.afterRelease)
    expect(onShow).not.toHaveBeenCalled()
    for (let step = 0; step < 10; step += 1) {
      vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle - TOUCH_SELECTION_DELAYS.afterRelease - 100)
      doc.emit('selectionchange')
    }
    expect(onShow).not.toHaveBeenCalled()
    expect(onHide).toHaveBeenCalledTimes(10)

    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    expect(onShow).toHaveBeenCalledTimes(1)
  })

  it('hides an open menu when a handle drag resumes, then reopens with the new selection', () => {
    const { doc, onShow, onHide, setSelection } = setup(false)
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    expect(onShow).toHaveBeenCalledTimes(1)

    const extended = { ...SELECTION, text: 'picked words and more' }
    setSelection(extended)
    doc.emit('selectionchange')
    expect(onHide).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    expect(onShow).toHaveBeenLastCalledWith(extended)
  })

  it('falls back to showing when the long-press touchend never arrives', () => {
    const { onShow } = setup()
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.touchHeld)
    expect(onShow).toHaveBeenCalledTimes(1)
  })

  it('does not open under a finger that rests on the page', () => {
    const { doc, onShow } = setup(false)
    doc.emit('touchstart', { target: {} })
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    expect(onShow).not.toHaveBeenCalled()
    doc.emit('touchend', { touches: { length: 0 } })
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.afterRelease)
    expect(onShow).toHaveBeenCalledTimes(1)
  })

  it('waits for every finger to lift', () => {
    const { doc, onShow } = setup()
    doc.emit('touchend', { touches: { length: 1 } })
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.afterRelease)
    expect(onShow).not.toHaveBeenCalled()
  })

  it('ignores selection changes caused by tapping a menu item', () => {
    const { doc, onShow, onHide } = setup(false)
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    expect(onShow).toHaveBeenCalledTimes(1)

    doc.emit('touchstart', { target: MENU })
    doc.emit('selectionchange')
    doc.emit('touchend', { touches: { length: 0 } })
    expect(onHide).not.toHaveBeenCalled()
  })

  it('hides during scroll and reopens once scrolling settles', () => {
    const { doc, onShow, onHide } = setup(false)
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    doc.emit('scroll')
    expect(onHide).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    expect(onShow).toHaveBeenCalledTimes(2)
  })

  it('releases when the selection is gone', () => {
    const { doc, onShow, onRelease, setSelection } = setup(false)
    setSelection(null)
    doc.emit('selectionchange')
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.idle)
    expect(onShow).not.toHaveBeenCalled()
    expect(onRelease).toHaveBeenCalledTimes(1)
  })

  it('removes every listener and pending timer on stop', () => {
    const { doc, onShow, stop } = setup()
    expect(doc.count()).toBe(5)
    stop()
    expect(doc.count()).toBe(0)
    vi.advanceTimersByTime(TOUCH_SELECTION_DELAYS.touchHeld)
    expect(onShow).not.toHaveBeenCalled()
  })
})

describe('isTouchContextMenu', () => {
  it('trusts the pointer type when the browser reports one', () => {
    expect(isTouchContextMenu({ pointerType: 'touch' }, null, 0)).toBe(true)
    expect(isTouchContextMenu({ pointerType: 'mouse' }, 900, 1000)).toBe(false)
  })

  it('falls back to touch capabilities and a recent touchstart', () => {
    expect(isTouchContextMenu({ sourceCapabilities: { firesTouchEvents: true } }, null, 0)).toBe(true)
    expect(isTouchContextMenu({}, 1000, 1600)).toBe(true)
    expect(isTouchContextMenu({}, 1000, 4000)).toBe(false)
    expect(isTouchContextMenu({}, null, 4000)).toBe(false)
  })
})

describe('readSelectionInside', () => {
  const inside = { id: 'inside' }
  const outside = { id: 'outside' }
  const container = { contains: (node: unknown) => node === inside }
  const selection = (overrides: Record<string, unknown> = {}) => ({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: inside,
    focusNode: inside,
    toString: () => '  hello world  ',
    getRangeAt: () => ({
      getClientRects: () => [
        { top: 100, bottom: 120, left: 30, right: 300, width: 270, height: 20 },
        { top: 120, bottom: 140, left: 10, right: 90, width: 80, height: 20 },
        { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
      ],
    }),
    ...overrides,
  })

  it('returns trimmed text and the union of the visible line boxes', () => {
    expect(readSelectionInside(container, selection())).toEqual({
      text: 'hello world',
      rect: { top: 100, bottom: 140, left: 10, right: 300 },
    })
  })

  it('accepts a selection that only ends inside the message', () => {
    expect(readSelectionInside(container, selection({ anchorNode: outside }))?.text).toBe('hello world')
  })

  it('rejects collapsed, blank or foreign selections', () => {
    expect(readSelectionInside(container, selection({ isCollapsed: true }))).toBeNull()
    expect(readSelectionInside(container, selection({ toString: () => '   ' }))).toBeNull()
    expect(readSelectionInside(container, selection({ anchorNode: outside, focusNode: outside }))).toBeNull()
    expect(readSelectionInside(null, selection())).toBeNull()
  })
})

describe('placeTouchSelectionMenu', () => {
  const menu = { width: 200, height: 160 }
  const viewport = { width: 400, height: 800 }

  it('sits above the selection like the native toolbar', () => {
    expect(placeTouchSelectionMenu({ top: 400, bottom: 440, left: 100, right: 300 }, menu, viewport)).toEqual({
      left: 100,
      top: 400 - 12 - 160,
    })
  })

  it('drops below the drag handles when there is no room above', () => {
    expect(placeTouchSelectionMenu({ top: 60, bottom: 100, left: 100, right: 300 }, menu, viewport)).toEqual({
      left: 100,
      top: 100 + 36,
    })
  })

  it('pins inside the viewport when the selection fills the screen', () => {
    expect(placeTouchSelectionMenu({ top: -500, bottom: 1500, left: 0, right: 400 }, menu, viewport)).toEqual({
      left: 100,
      top: 800 - 8 - 160,
    })
  })

  it('clamps horizontally to the viewport margins', () => {
    expect(placeTouchSelectionMenu({ top: 400, bottom: 440, left: 0, right: 20 }, menu, viewport)?.left).toBe(8)
    expect(placeTouchSelectionMenu({ top: 400, bottom: 440, left: 380, right: 400 }, menu, viewport)?.left).toBe(192)
  })

  it('returns null when the selection is scrolled out of view', () => {
    expect(placeTouchSelectionMenu({ top: -80, bottom: -20, left: 0, right: 100 }, menu, viewport)).toBeNull()
    expect(placeTouchSelectionMenu({ top: 820, bottom: 860, left: 0, right: 100 }, menu, viewport)).toBeNull()
  })
})
