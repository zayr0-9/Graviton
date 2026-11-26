import { useSyncExternalStore } from 'react'

const key = 'chat:userDisplayName'
const changeEvent = 'userDisplayNameChange'
let fallback = ''

export function readChatDisplayName(): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return fallback
  }
}

export function saveChatDisplayName(name: string): void {
  fallback = name
  try {
    if (name) localStorage.setItem(key, name)
    else localStorage.removeItem(key)
  } catch { /* Keep the preference in memory when storage is unavailable. */ }
  window.dispatchEvent(new Event(changeEvent))
}

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) notify()
  }
  window.addEventListener(changeEvent, notify)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(changeEvent, notify)
    window.removeEventListener('storage', onStorage)
  }
}

export function useChatDisplayName(): string {
  return useSyncExternalStore(subscribe, readChatDisplayName, readChatDisplayName)
}
