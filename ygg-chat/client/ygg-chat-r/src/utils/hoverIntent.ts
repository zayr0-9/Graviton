// Hover intent ("menu aim" / safe triangle), framework-free so it is unit-testable.
//
// When a hover surface (preview card, submenu, dropdown panel) sits away from its
// trigger, the pointer crosses other triggers on the way. A naive hover handler
// swaps or closes the surface as soon as it does. This controller defers those
// actions while the pointer is travelling toward the surface, and lets them run
// once the pointer changes direction or stalls.

export interface HoverIntentPoint {
  x: number
  y: number
}

export interface HoverIntentRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface HoverIntentOptions {
  /** Client-space rect of the open surface the pointer may be heading to, or null when closed. */
  getTargetRect: () => HoverIntentRect | null
  /** Deferred actions run once the pointer has not moved for this long. */
  stallMs?: number
  /** Grows the target so slightly inaccurate paths still count as aiming. */
  tolerancePx?: number
  now?: () => number
}

export interface HoverIntentController {
  /** Feed client-space pointer positions (typically from a window pointermove listener). */
  track: (x: number, y: number) => void
  /** Runs `action` now, or defers it while the pointer is aiming at the target. Replaces any pending action. */
  run: (action: () => void) => void
  /** Drops the pending action, e.g. when the pointer reaches the target or leaves the trigger it was for. */
  cancel: () => void
  isAiming: () => boolean
  /** Cancels and forgets pointer history; the controller remains usable. */
  reset: () => void
}

export const HOVER_INTENT_DEFAULT_STALL_MS = 250
export const HOVER_INTENT_DEFAULT_TOLERANCE_PX = 24
// Comparing against a slightly older sample smooths out single-pixel jitter.
const TRACKED_POINTS = 3

const normalizeAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))

/**
 * True when movement from `from` to `to` points into the wedge `from` sees `rect` through.
 * Directional rather than containment-based, so sideways browsing still switches immediately.
 */
export function isPointerAimingAtRect(
  from: HoverIntentPoint,
  to: HoverIntentPoint,
  rect: HoverIntentRect,
  tolerancePx = 0
): boolean {
  const left = rect.left - tolerancePx
  const right = rect.right + tolerancePx
  const top = rect.top - tolerancePx
  const bottom = rect.bottom + tolerancePx

  if (to.x >= left && to.x <= right && to.y >= top && to.y <= bottom) return true

  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return false
  if (from.x >= left && from.x <= right && from.y >= top && from.y <= bottom) return false

  // Measure angles relative to the rect centre so the wedge never straddles ±π.
  const baseAngle = Math.atan2((top + bottom) / 2 - from.y, (left + right) / 2 - from.x)
  let minDelta = Infinity
  let maxDelta = -Infinity
  for (const [cx, cy] of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
    const delta = normalizeAngle(Math.atan2(cy - from.y, cx - from.x) - baseAngle)
    minDelta = Math.min(minDelta, delta)
    maxDelta = Math.max(maxDelta, delta)
  }

  const motionDelta = normalizeAngle(Math.atan2(dy, dx) - baseAngle)
  return motionDelta >= minDelta && motionDelta <= maxDelta
}

export function createHoverIntentController(options: HoverIntentOptions): HoverIntentController {
  const stallMs = options.stallMs ?? HOVER_INTENT_DEFAULT_STALL_MS
  const tolerancePx = options.tolerancePx ?? HOVER_INTENT_DEFAULT_TOLERANCE_PX
  const now = options.now ?? (() => Date.now())

  let points: HoverIntentPoint[] = []
  let lastMoveAt = 0
  let pending: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const isAiming = () => {
    if (points.length < 2) return false
    const rect = options.getTargetRect()
    if (!rect) return false
    return isPointerAimingAtRect(points[0], points[points.length - 1], rect, tolerancePx)
  }

  const flush = () => {
    clearTimer()
    const action = pending
    pending = null
    action?.()
  }

  const scheduleCheck = (delay: number) => {
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      if (!pending) return
      const idle = now() - lastMoveAt
      if (idle >= stallMs || !isAiming()) {
        flush()
      } else {
        scheduleCheck(stallMs - idle)
      }
    }, Math.max(0, delay))
  }

  return {
    track(x, y) {
      const last = points[points.length - 1]
      if (last && last.x === x && last.y === y) return
      points.push({ x, y })
      if (points.length > TRACKED_POINTS) points.shift()
      lastMoveAt = now()
      // A change of direction releases the deferred action without waiting for a stall.
      if (pending && !isAiming()) flush()
    },
    run(action) {
      if (!isAiming()) {
        pending = null
        clearTimer()
        action()
        return
      }
      pending = action
      if (timer === null) scheduleCheck(stallMs - (now() - lastMoveAt))
    },
    cancel() {
      pending = null
      clearTimer()
    },
    isAiming,
    reset() {
      pending = null
      clearTimer()
      points = []
    },
  }
}
