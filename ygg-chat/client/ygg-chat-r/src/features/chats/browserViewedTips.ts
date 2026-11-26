import { getHostRuntime } from '../../services/hostRuntimeBootstrap'

// Store only opaque IDs, never transcript content. Each browser origin/host/user
// remembers its own recent views; navigation on a phone does not move the desktop.
function key(userId?: string) {
  const hostId = getHostRuntime()?.hostId
  return hostId && userId ? `chat:viewedTips:${JSON.stringify([hostId, userId])}` : null
}
function entries(storageKey: string): Array<[string, string]> {
  const rows: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
  return Array.isArray(rows) ? rows.filter((row): row is [string, string] =>
    Array.isArray(row) && row.length === 2 && row.every(value => typeof value === 'string')).slice(-100) : []
}
export function readBrowserViewedTip(userId: string | undefined, conversationId: string) {
  try { const k = key(userId); return k ? new Map(entries(k)).get(conversationId) : undefined } catch { return undefined }
}
export function saveBrowserViewedTip(userId: string | undefined, conversationId: string, tip: string) {
  try {
    const k = key(userId)
    if (!k) return
    const rows = entries(k).filter(([id]) => id !== conversationId)
    localStorage.setItem(k, JSON.stringify([...rows, [conversationId, tip]].slice(-100)))
  } catch { /* Optional navigation hint. */ }
}
