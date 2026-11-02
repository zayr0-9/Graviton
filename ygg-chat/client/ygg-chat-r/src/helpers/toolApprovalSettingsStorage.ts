import { getHostExecutionPreferences, saveHostExecutionPreference } from '../services/hostExecutionClient'
export const DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY = 'chat:defaultToolAutoApprove'

export function loadDefaultToolAutoApprove(): boolean {
  const host = getHostExecutionPreferences()
  if (host) return host.toolAutoApprove
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export async function saveDefaultToolAutoApprove(enabled: boolean): Promise<void> {
  if (getHostExecutionPreferences()) { await saveHostExecutionPreference({ toolAutoApprove: enabled }); return }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY, String(enabled))
    }
  } catch (error) {
    console.error('Failed to save default tool approval:', error)
  }
}

export const CLAUDE_AUTO_MODE_STORAGE_KEY = 'chat:claudeAutoMode'

export function loadClaudeAutoMode(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CLAUDE_AUTO_MODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveClaudeAutoMode(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CLAUDE_AUTO_MODE_STORAGE_KEY, String(enabled))
  } catch (error) {
    console.error('Failed to save Claude auto mode:', error)
  }
}

export const CLAUDE_ULTRACODE_STORAGE_KEY = 'chat:claudeUltracode'

export function loadClaudeUltracode(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CLAUDE_ULTRACODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveClaudeUltracode(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CLAUDE_ULTRACODE_STORAGE_KEY, String(enabled))
  } catch (error) {
    console.error('Failed to save Claude ultracode:', error)
  }
}
