import { useEffect, useState } from 'react'
import { loadShortcutOverrides, subscribeShortcutOverrides } from './shortcutPreferences'

/** Update command labels as well as handlers on same-window and cross-window saves. */
export const useShortcutOverrides = () => {
  const [overrides, setOverrides] = useState(loadShortcutOverrides)
  useEffect(() => {
    const refresh = () => setOverrides(loadShortcutOverrides())
    const unsubscribe = subscribeShortcutOverrides(refresh)
    refresh()
    return unsubscribe
  }, [])
  return overrides
}
