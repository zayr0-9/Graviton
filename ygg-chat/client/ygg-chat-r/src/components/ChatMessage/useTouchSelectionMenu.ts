import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  isTouchContextMenu,
  readSelectionInside,
  startTouchSelectionSession,
  type SettledSelection,
} from './touchSelectionMenu'

interface TouchSelectionOwner {
  cancel: () => void
}

// Only one message owns a touch selection. A selection dragged across rows can fire
// `contextmenu` on another message; the newest arm wins so two menus never open.
let activeOwner: TouchSelectionOwner | null = null

interface UseTouchSelectionMenuOptions {
  containerRef: RefObject<HTMLElement | null>
  menuRef: RefObject<HTMLElement | null>
  onShow: (selection: SettledSelection) => void
  onHide: () => void
}

/**
 * Touch counterpart of the right-click selection menu. Call `noteTouchStart` from the row's
 * touchstart and `armFromContextMenu` from its contextmenu handler; the menu is shown through
 * `onShow` only after the selection settles, and hidden through `onHide` while it changes.
 */
export function useTouchSelectionMenu({ containerRef, menuRef, onShow, onHide }: UseTouchSelectionMenuOptions) {
  const lastTouchStartAtRef = useRef<number | null>(null)
  // 0 = disarmed. Each arm bumps the id so a repeated long-press restarts the session.
  const [sessionId, setSessionId] = useState(0)
  const callbacksRef = useRef({ onShow, onHide })
  callbacksRef.current = { onShow, onHide }

  const ownerRef = useRef<TouchSelectionOwner | null>(null)
  if (!ownerRef.current) {
    ownerRef.current = {
      cancel: () => {
        setSessionId(0)
        callbacksRef.current.onHide()
      },
    }
  }

  const disarm = useCallback(() => {
    if (activeOwner === ownerRef.current) activeOwner = null
    setSessionId(0)
  }, [])

  const noteTouchStart = useCallback(() => {
    lastTouchStartAtRef.current = performance.now()
  }, [])

  /**
   * Returns true when `event` is a touch long-press over selected text in this row. The caller
   * must then prevent the native menu and skip its own immediate menu.
   */
  const armFromContextMenu = useCallback((event: { nativeEvent: Event }) => {
    const native = event.nativeEvent as Event & { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } | null }
    if (!isTouchContextMenu(native, lastTouchStartAtRef.current, performance.now())) return false
    if (!readSelectionInside(containerRef.current, window.getSelection())) return false
    const owner = ownerRef.current!
    if (activeOwner && activeOwner !== owner) activeOwner.cancel()
    activeOwner = owner
    setSessionId(id => id + 1)
    return true
  }, [containerRef])

  useEffect(() => {
    if (sessionId === 0 || typeof document === 'undefined') return
    const owner = ownerRef.current
    const stop = startTouchSelectionSession(
      {
        target: document,
        readSelection: () => readSelectionInside(containerRef.current, window.getSelection()),
        isInsideMenu: node => Boolean(menuRef.current && node instanceof Node && menuRef.current.contains(node)),
        onShow: selection => callbacksRef.current.onShow(selection),
        onHide: () => callbacksRef.current.onHide(),
        onRelease: () => {
          callbacksRef.current.onHide()
          if (activeOwner === owner) activeOwner = null
          setSessionId(0)
        },
      },
      true
    )
    return stop
  }, [sessionId, containerRef, menuRef])

  useEffect(() => () => {
    if (activeOwner === ownerRef.current) activeOwner = null
  }, [])

  return { noteTouchStart, armFromContextMenu, disarm }
}
