import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateDockedPreviewLayout, observeHeimdallViewport } from './heimdallViewport'

afterEach(() => vi.unstubAllGlobals())

describe('observeHeimdallViewport', () => {
  it('measures panel resizes without a window resize and cleans up listeners', () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event, callback) => listeners.set(event, callback)),
      removeEventListener: vi.fn((event, callback) => {
        if (listeners.get(event) === callback) listeners.delete(event)
      }),
    })
    let resizePanel: () => void = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizePanel = callback }
      observe = observe
      disconnect = disconnect
    })
    // Different outer sizes ensure positioning uses the panel's inner viewport.
    const container = { clientWidth: 800, clientHeight: 700, offsetWidth: 802, offsetHeight: 702 }
    const onSize = vi.fn()
    const cleanup = observeHeimdallViewport(container as HTMLElement, onSize)
    expect(observe).toHaveBeenCalledWith(container)
    expect(onSize).toHaveBeenLastCalledWith({ width: 800, height: 700 })

    container.clientWidth = 480
    resizePanel()
    expect(onSize).toHaveBeenLastCalledWith({ width: 480, height: 700 })
    container.clientHeight = 300
    resizePanel()
    expect(onSize).toHaveBeenLastCalledWith({ width: 480, height: 300 })

    cleanup()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })

  it('retains window resize fallback when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    vi.stubGlobal('window', { addEventListener, removeEventListener })
    const container = { clientWidth: 600, clientHeight: 400 }
    const onSize = vi.fn()
    const cleanup = observeHeimdallViewport(container as HTMLElement, onSize)
    const updateSize = addEventListener.mock.calls[0][1]
    container.clientWidth = 500
    updateSize()
    expect(onSize).toHaveBeenLastCalledWith({ width: 500, height: 400 })
    cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('resize', updateSize)
  })
})

describe('calculateDockedPreviewLayout', () => {
  it('preserves opposite-side docking and preferred text size in a large panel', () => {
    const dimensions = { width: 800, height: 700 }
    expect(calculateDockedPreviewLayout(dimensions, { x: 100, y: 100 }, 320, 450))
      .toEqual({ left: 468, top: 100, width: 320, maxHeight: 450 })
    expect(calculateDockedPreviewLayout(dimensions, { x: 700, y: 100 }, 320, 450).left).toBe(12)
  })

  it('recalculates placement after sidebar expansion shrinks the panel', () => {
    const anchor = { x: 100, y: 100 }
    const before = calculateDockedPreviewLayout({ width: 800, height: 700 }, anchor, 320, 450)
    const after = calculateDockedPreviewLayout({ width: 480, height: 700 }, anchor, 320, 450)
    expect(after.left).toBeLessThan(before.left)
    expect(after.left + after.width).toBe(468)
  })

  it.each([
    [180, 300, 320, 450],
    [400, 320, 800, 600],
    [600, 250, 320, 450],
    [0, 0, 320, 450],
  ])('contains previews in a %ix%i panel with preferred size %ix%i', (width, height, preferredWidth, preferredHeight) => {
    for (const x of [-100, width / 2, width + 100]) {
      for (const y of [-100, height / 2, height + 100]) {
        const layout = calculateDockedPreviewLayout({ width, height }, { x, y }, preferredWidth, preferredHeight)
        expect(layout.left).toBeGreaterThanOrEqual(0)
        expect(layout.top).toBeGreaterThanOrEqual(0)
        expect(layout.width).toBeGreaterThanOrEqual(0)
        expect(layout.maxHeight).toBeGreaterThanOrEqual(0)
        expect(layout.left + layout.width).toBeLessThanOrEqual(width)
        expect(layout.top + layout.maxHeight).toBeLessThanOrEqual(height)
      }
    }
  })
})
