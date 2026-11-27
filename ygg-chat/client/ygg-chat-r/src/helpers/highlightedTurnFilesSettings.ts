import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'chat:showHighlightedTurnFiles'
const CHANGE_EVENT = 'highlightedTurnFilesChange'

export function loadHighlightedTurnFiles(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveHighlightedTurnFiles(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled))
  } catch { /* Keep storage failures non-fatal, like other chat settings. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange()
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function useHighlightedTurnFiles(): boolean {
  return useSyncExternalStore(subscribe, loadHighlightedTurnFiles, loadHighlightedTurnFiles)
}
