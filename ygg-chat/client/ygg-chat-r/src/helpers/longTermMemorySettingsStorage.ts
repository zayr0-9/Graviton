import { getHostExecutionPreferences, saveHostExecutionPreference } from '../services/hostExecutionClient'
export const LONG_TERM_MEMORY_CONTEXT_ENABLED_KEY = 'chat:longTermMemoryContextEnabled'
export const LONG_TERM_MEMORY_CONTEXT_ENABLED_CHANGE_EVENT = 'chat:longTermMemoryContextEnabledChange'

export const loadLongTermMemoryContextEnabled = (): boolean => {
  const host = getHostExecutionPreferences()
  if (host) return host.longTermMemoryContextEnabled
  try {
    const stored = localStorage.getItem(LONG_TERM_MEMORY_CONTEXT_ENABLED_KEY)
    return stored === null ? true : stored === 'true'
  } catch {
    return true
  }
}

export const saveLongTermMemoryContextEnabled = async (enabled: boolean): Promise<void> => {
  if (getHostExecutionPreferences()) { await saveHostExecutionPreference({ longTermMemoryContextEnabled: enabled }); return }
  try {
    localStorage.setItem(LONG_TERM_MEMORY_CONTEXT_ENABLED_KEY, String(enabled))
    window.dispatchEvent(new CustomEvent<boolean>(LONG_TERM_MEMORY_CONTEXT_ENABLED_CHANGE_EVENT, { detail: enabled }))
  } catch {
    // no-op
  }
}
