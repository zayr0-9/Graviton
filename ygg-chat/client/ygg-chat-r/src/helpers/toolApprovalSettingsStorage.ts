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

export type ClaudeToolApproval = 'ask' | 'auto' | 'allow_all'
export const CLAUDE_TOOL_APPROVAL_STORAGE_KEY = 'chat:claudeToolApprovalDefault'
// Written by the old Chat auto toggle; read once as the Claude default until Settings saves one.
const LEGACY_CLAUDE_AUTO_MODE_STORAGE_KEY = 'chat:claudeAutoMode'

/** Claude's own launch default; null follows the shared Default Tool Approval. */
export function loadClaudeToolApprovalDefault(): ClaudeToolApproval | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const stored = localStorage.getItem(CLAUDE_TOOL_APPROVAL_STORAGE_KEY)
    if (stored === 'ask' || stored === 'auto' || stored === 'allow_all') return stored
    return localStorage.getItem(LEGACY_CLAUDE_AUTO_MODE_STORAGE_KEY) === 'true' ? 'auto' : null
  } catch {
    return null
  }
}

export function saveClaudeToolApprovalDefault(value: ClaudeToolApproval): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CLAUDE_TOOL_APPROVAL_STORAGE_KEY, value)
  } catch (error) {
    console.error('Failed to save Claude tool approval default:', error)
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
