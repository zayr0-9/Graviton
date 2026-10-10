import { useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { getTitleBarHistoryDelta, recordTitleBarLocation } from './titleBarHistory'
import type { TitleBarHistory } from './titleBarHistory'

export const useTitleBarHistory = () => {
  const location = useLocation()
  const action = useNavigationType()
  const navigate = useNavigate()
  // Both HashRouter and BrowserRouter store their entry index here. Keep real
  // history entries so search/hash, location state and normal POP behavior survive.
  const rawIndex = window.history.state?.idx
  const index = Number.isInteger(rawIndex) ? rawIndex as number : null
  const [history, setHistory] = useState<TitleBarHistory>(new Map())
  const [isNavigating, setIsNavigating] = useState(false)
  const navigationPending = useRef(false)

  useLayoutEffect(() => {
    if (index !== null) {
      setHistory(previous => recordTitleBarLocation(previous, index, location.pathname, action))
    }
    navigationPending.current = false
    setIsNavigating(false)
  }, [location, action, index])

  const backDelta = index === null ? null : getTitleBarHistoryDelta(history, index, -1)
  const forwardDelta = index === null ? null : getTitleBarHistoryDelta(history, index, 1)

  const go = (delta: number | null) => {
    if (delta === null || navigationPending.current) return
    // history.go is asynchronous; don't queue multiple jumps before the POP arrives.
    navigationPending.current = true
    setIsNavigating(true)
    navigate(delta)
  }

  return {
    canGoBack: !isNavigating && backDelta !== null,
    canGoForward: !isNavigating && forwardDelta !== null,
    goBack: () => go(backDelta),
    goForward: () => go(forwardDelta),
  }
}
