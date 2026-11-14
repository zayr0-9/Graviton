// Touch text-selection menu timing and placement. Framework-free so the session logic can be
// tested without a DOM; `useTouchSelectionMenu` wires it to React and the real document.
//
// Why this exists: Android Chrome fires `contextmenu` on the long-press that *starts* a text
// selection. Opening the selection menu there puts it under the user's finger while they are
// still dragging the selection handles, and captures only the first word. On touch we instead
// arm a session at the long-press and show the menu once the selection has settled.
//
// The browser owns the selection handles, so dragging them sends the page no touch events, only
// `selectionchange`. A settled selection therefore means one of:
//   - the finger touching the page lifted (touchend), or
//   - `selectionchange` stopped firing for a short idle period (handle drags, or after the
//     browser cancels the page touch to run its own selection gesture).

export interface SelectionRect {
  top: number
  bottom: number
  left: number
  right: number
}

export interface SettledSelection {
  text: string
  rect: SelectionRect
}

export interface TouchSelectionDelays {
  /** After the last page touch lifts. */
  afterRelease: number
  /** After the last `selectionchange`/scroll with no page touch down (handle drags). */
  idle: number
  /** Fallback while a page touch is believed down but its touchend may have been swallowed. */
  touchHeld: number
}

export const TOUCH_SELECTION_DELAYS: TouchSelectionDelays = {
  afterRelease: 200,
  idle: 700,
  touchHeld: 1200,
}

/** A `contextmenu` this soon after a touchstart on the same row came from a long-press. */
export const TOUCH_CONTEXT_MENU_WINDOW_MS = 1500

type Listener = (event: any) => void

export interface TouchSelectionEventTarget {
  addEventListener: (type: string, listener: Listener, options?: AddEventListenerOptions | boolean) => void
  removeEventListener: (type: string, listener: Listener, options?: EventListenerOptions | boolean) => void
}

export interface TouchSelectionSessionDeps {
  /** Usually `document`: receives selectionchange, touch and (captured) scroll events. */
  target: TouchSelectionEventTarget
  /** Current selection if it still belongs to the owning message, else null. */
  readSelection: () => SettledSelection | null
  /** True when a touch starts inside the open menu (its taps must not hide it). */
  isInsideMenu: (eventTarget: unknown) => boolean
  onShow: (selection: SettledSelection) => void
  /** Hide while the user is still adjusting; the session stays armed. */
  onHide: () => void
  /** Selection is gone or left the message; the session should end. */
  onRelease: () => void
  delays?: Partial<TouchSelectionDelays>
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Runs one touch-selection session and returns its stop function. `touchActive` is true when the
 * session starts from a long-press whose finger is still down.
 */
export function startTouchSelectionSession(deps: TouchSelectionSessionDeps, touchActive: boolean): () => void {
  const delays = { ...TOUCH_SELECTION_DELAYS, ...deps.delays }
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>))
  let touching = touchActive
  let menuInteraction = false
  let timer: unknown = null
  let stopped = false

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const settle = () => {
    timer = null
    if (stopped) return
    const selection = deps.readSelection()
    if (selection) deps.onShow(selection)
    else deps.onRelease()
  }
  const schedule = (ms: number) => {
    cancelTimer()
    timer = setTimer(settle, ms)
  }
  const restartAfterChange = () => {
    if (menuInteraction) return
    deps.onHide()
    schedule(touching ? delays.touchHeld : delays.idle)
  }
  const handleTouchStart = (event: { target?: unknown }) => {
    menuInteraction = deps.isInsideMenu(event.target)
    if (menuInteraction) return
    touching = true
    // Wait for the lift (or the held fallback) instead of opening under a resting finger.
    schedule(delays.touchHeld)
  }
  const handleTouchEnd = (event: { touches?: { length: number } }) => {
    if (menuInteraction) return
    if (event.touches && event.touches.length > 0) return
    touching = false
    schedule(delays.afterRelease)
  }
  // touchcancel means the browser took the gesture over (for example a long-press turning into
  // a selection drag), so the finger may still be down. Fall back to waiting for selection idle.
  const handleTouchCancel = (event: { touches?: { length: number } }) => {
    if (menuInteraction) return
    if (event.touches && event.touches.length > 0) return
    touching = false
    schedule(delays.idle)
  }

  const passiveCapture = { capture: true, passive: true }
  deps.target.addEventListener('selectionchange', restartAfterChange)
  deps.target.addEventListener('scroll', restartAfterChange, passiveCapture)
  deps.target.addEventListener('touchstart', handleTouchStart, passiveCapture)
  deps.target.addEventListener('touchend', handleTouchEnd, passiveCapture)
  deps.target.addEventListener('touchcancel', handleTouchCancel, passiveCapture)
  schedule(touching ? delays.touchHeld : delays.idle)

  return () => {
    stopped = true
    cancelTimer()
    deps.target.removeEventListener('selectionchange', restartAfterChange)
    deps.target.removeEventListener('scroll', restartAfterChange, { capture: true })
    deps.target.removeEventListener('touchstart', handleTouchStart, { capture: true })
    deps.target.removeEventListener('touchend', handleTouchEnd, { capture: true })
    deps.target.removeEventListener('touchcancel', handleTouchCancel, { capture: true })
  }
}

export interface ContextMenuSource {
  pointerType?: string
  sourceCapabilities?: { firesTouchEvents?: boolean } | null
}

/** Long-press (touch) contextmenu versus mouse right-click / keyboard menu key. */
export function isTouchContextMenu(source: ContextMenuSource, lastTouchStartAt: number | null, now: number): boolean {
  if (source.pointerType === 'touch') return true
  if (source.pointerType === 'mouse') return false
  if (source.sourceCapabilities?.firesTouchEvents) return true
  return lastTouchStartAt !== null && now - lastTouchStartAt >= 0 && now - lastTouchStartAt < TOUCH_CONTEXT_MENU_WINDOW_MS
}

interface SelectionLike {
  isCollapsed: boolean
  rangeCount: number
  anchorNode: unknown
  focusNode: unknown
  toString: () => string
  getRangeAt: (index: number) => {
    getClientRects?: () => ArrayLike<SelectionRect & { width: number; height: number }>
    getBoundingClientRect?: () => SelectionRect
  }
}

/** The selection's text and visual bounds when it starts or ends inside `container`. */
export function readSelectionInside(
  container: { contains: (node: any) => boolean } | null,
  selection: SelectionLike | null
): SettledSelection | null {
  if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const { anchorNode, focusNode } = selection
  const inside = (anchorNode && container.contains(anchorNode)) || (focusNode && container.contains(focusNode))
  if (!inside) return null
  const text = selection.toString().trim()
  if (!text) return null
  const range = selection.getRangeAt(0)
  const rects = Array.from(range.getClientRects?.() ?? []).filter(rect => rect.width > 0 || rect.height > 0)
  if (rects.length > 0) {
    return {
      text,
      rect: {
        top: Math.min(...rects.map(rect => rect.top)),
        bottom: Math.max(...rects.map(rect => rect.bottom)),
        left: Math.min(...rects.map(rect => rect.left)),
        right: Math.max(...rects.map(rect => rect.right)),
      },
    }
  }
  const bounds = range.getBoundingClientRect?.()
  return bounds ? { text, rect: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right } } : null
}

export interface MenuPlacementOptions {
  margin?: number
  gap?: number
  /** Space below the selection kept clear for the browser's drag handles. */
  handleClearance?: number
}

/**
 * Top-left position for the menu: above the selection like the native toolbar, else below the
 * drag handles, else pinned inside the viewport. Null when the selection is scrolled out of view.
 */
export function placeTouchSelectionMenu(
  anchor: SelectionRect,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  { margin = 8, gap = 12, handleClearance = 36 }: MenuPlacementOptions = {}
): { left: number; top: number } | null {
  if (anchor.bottom <= 0 || anchor.top >= viewport.height || anchor.right <= 0 || anchor.left >= viewport.width) return null
  const visibleTop = Math.max(anchor.top, 0)
  const visibleBottom = Math.min(anchor.bottom, viewport.height)
  const centerX = (Math.max(anchor.left, 0) + Math.min(anchor.right, viewport.width)) / 2
  const maxLeft = Math.max(margin, viewport.width - margin - menu.width)
  const left = Math.min(Math.max(centerX - menu.width / 2, margin), maxLeft)
  const maxTop = Math.max(margin, viewport.height - margin - menu.height)

  const above = visibleTop - gap - menu.height
  if (above >= margin) return { left, top: above }
  const below = visibleBottom + handleClearance
  if (below <= maxTop) return { left, top: below }
  return { left, top: maxTop }
}
