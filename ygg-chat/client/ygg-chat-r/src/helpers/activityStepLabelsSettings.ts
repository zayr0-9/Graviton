import { useSyncExternalStore } from 'react'

export const ACTIVITY_STEP_LABELS_KEY = 'chat:showActivityStepLabels'
const CHANGE_EVENT = 'activityStepLabelsChange'

export function loadActivityStepLabels(): boolean {
  try {
    return localStorage.getItem(ACTIVITY_STEP_LABELS_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveActivityStepLabels(enabled: boolean): void {
  try {
    localStorage.setItem(ACTIVITY_STEP_LABELS_KEY, String(enabled))
  } catch { /* Keep storage failures non-fatal, like other chat appearance settings. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ACTIVITY_STEP_LABELS_KEY || event.key === null) onChange()
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function useActivityStepLabels(): boolean {
  return useSyncExternalStore(subscribe, loadActivityStepLabels, loadActivityStepLabels)
}
