export const DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY = 'chat:defaultToolAutoApprove'

export function loadDefaultToolAutoApprove(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveDefaultToolAutoApprove(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY, String(enabled))
    }
  } catch (error) {
    console.error('Failed to save default tool approval:', error)
  }
}
