import { useEffect, useRef, useState } from 'react'
import { createHoverIntentController } from '../utils/hoverIntent'
import type { HoverIntentController, HoverIntentRect } from '../utils/hoverIntent'

export interface UseHoverIntentOptions {
  /** Client-space rect of the open hover surface (usually `ref.current?.getBoundingClientRect()`). */
  getTargetRect: () => HoverIntentRect | null
  /** Track the pointer only while the surface is open. */
  enabled?: boolean
  stallMs?: number
  tolerancePx?: number
}

/**
 * Safe-triangle hover intent for previews, submenus and hover dropdowns.
 *
 * Wrap trigger-enter swaps and delayed closes in `run()`; call `cancel()` when the
 * pointer enters the surface or leaves the trigger a deferred swap belonged to.
 * The returned controller is stable for the component's lifetime.
 */
export function useHoverIntent({ getTargetRect, enabled = true, stallMs, tolerancePx }: UseHoverIntentOptions): HoverIntentController {
  const getTargetRectRef = useRef(getTargetRect)
  getTargetRectRef.current = getTargetRect

  const [controller] = useState(() =>
    createHoverIntentController({ getTargetRect: () => getTargetRectRef.current(), stallMs, tolerancePx })
  )

  useEffect(() => {
    if (!enabled) return
    // Capture phase so pointer capture or stopPropagation inside the app cannot hide movement.
    const onPointerMove = (event: PointerEvent) => controller.track(event.clientX, event.clientY)
    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
      // Stale history from a previous open would make the next open look like aiming.
      controller.reset()
    }
  }, [controller, enabled])

  return controller
}
