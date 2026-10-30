import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHoverIntentController, isPointerAimingAtRect } from './hoverIntent'
import type { HoverIntentRect } from './hoverIntent'

// Card docked on the right of the panel, as Heimdall does for left-half anchors.
const card: HoverIntentRect = { left: 600, top: 100, right: 900, bottom: 500 }

describe('isPointerAimingAtRect', () => {
  it('accepts movement toward the rect, including diagonal paths that end on its edge', () => {
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 110, y: 300 }, card)).toBe(true)
    // From (100, 300) the card's left-edge corners lie at slopes of ±0.4.
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 110, y: 297 }, card)).toBe(true)
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 110, y: 303 }, card)).toBe(true)
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 110, y: 306 }, card)).toBe(false)
  })

  it('rejects sideways and backwards movement', () => {
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 100, y: 320 }, card)).toBe(false)
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 90, y: 300 }, card)).toBe(false)
    // Steeply up and right misses the card's top-left corner.
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 102, y: 280 }, card)).toBe(false)
  })

  it('works for targets on any side, using the visible corners', () => {
    const above: HoverIntentRect = { left: 0, top: 0, right: 200, bottom: 50 }
    expect(isPointerAimingAtRect({ x: 300, y: 300 }, { x: 290, y: 290 }, above)).toBe(true)
    expect(isPointerAimingAtRect({ x: 300, y: 300 }, { x: 310, y: 290 }, above)).toBe(false)
    const left: HoverIntentRect = { left: 0, top: 0, right: 100, bottom: 600 }
    expect(isPointerAimingAtRect({ x: 400, y: 300 }, { x: 390, y: 302 }, left)).toBe(true)
  })

  it('treats a pointer inside the (tolerance-grown) rect as aiming and no movement as not aiming', () => {
    expect(isPointerAimingAtRect({ x: 590, y: 300 }, { x: 595, y: 300 }, card, 8)).toBe(true)
    expect(isPointerAimingAtRect({ x: 100, y: 300 }, { x: 100, y: 300 }, card)).toBe(false)
  })

  it('tolerance widens the wedge', () => {
    const from = { x: 100, y: 300 }
    const justAbove = { x: 110, y: 295 }
    expect(isPointerAimingAtRect(from, justAbove, card, 0)).toBe(false)
    expect(isPointerAimingAtRect(from, justAbove, card, 40)).toBe(true)
  })
})

describe('createHoverIntentController', () => {
  let now = 0
  let target: HoverIntentRect | null = card
  const create = () =>
    createHoverIntentController({ getTargetRect: () => target, stallMs: 250, tolerancePx: 0, now: () => now })
  const move = (controller: ReturnType<typeof create>, x: number, y: number, ms = 16) => {
    now += ms
    vi.advanceTimersByTime(ms)
    controller.track(x, y)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    now = 0
    target = card
  })
  afterEach(() => vi.useRealTimers())

  it('runs immediately when no target is open or the pointer has no history', () => {
    const controller = create()
    const action = vi.fn()
    controller.run(action)
    expect(action).toHaveBeenCalledTimes(1)

    target = null
    move(controller, 100, 300)
    move(controller, 120, 300)
    controller.run(action)
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('defers while aiming and runs the latest action once the pointer stalls', () => {
    const controller = create()
    move(controller, 100, 300)
    move(controller, 120, 300)
    const first = vi.fn()
    const second = vi.fn()
    controller.run(first)
    move(controller, 140, 300)
    controller.run(second)
    vi.advanceTimersByTime(200)
    expect(second).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60)
    now += 260
    vi.advanceTimersByTime(250)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps deferring while the pointer keeps travelling toward the target', () => {
    const controller = create()
    move(controller, 100, 300)
    move(controller, 120, 300)
    const action = vi.fn()
    controller.run(action)
    for (let x = 140; x < 600; x += 20) move(controller, x, 300, 100)
    expect(action).not.toHaveBeenCalled()
  })

  it('runs as soon as the pointer turns away', () => {
    const controller = create()
    move(controller, 100, 300)
    move(controller, 120, 300)
    const action = vi.fn()
    controller.run(action)
    move(controller, 120, 340)
    move(controller, 120, 380)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('cancel drops the pending action and reset forgets pointer history', () => {
    const controller = create()
    move(controller, 100, 300)
    move(controller, 120, 300)
    const action = vi.fn()
    controller.run(action)
    controller.cancel()
    now += 1000
    vi.advanceTimersByTime(1000)
    expect(action).not.toHaveBeenCalled()

    controller.reset()
    expect(controller.isAiming()).toBe(false)
    controller.run(action)
    expect(action).toHaveBeenCalledTimes(1)
  })
})
