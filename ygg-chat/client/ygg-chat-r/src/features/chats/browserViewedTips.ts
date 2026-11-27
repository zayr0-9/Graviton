import { getHostRuntime } from '../../services/hostRuntimeBootstrap'

import { isNativeShell } from '../../platform/clientCapabilities'

// Store only opaque IDs. Electron's local profile owns its host; an attached
// browser needs the verified host ID because another host can reuse its URL.
function key(userId?: string) {
  const hostId = isNativeShell ? 'electron-local' : getHostRuntime()?.hostId
  return hostId && userId ? `chat:viewedTips:${JSON.stringify([hostId, userId])}` : null
}
function entries(storageKey: string): Array<[string, string]> {
  const rows: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
  return Array.isArray(rows) ? rows.filter((row): row is [string, string] =>
    Array.isArray(row) && row.length === 2 && row.every(value => typeof value === 'string')).slice(-100) : []
}
export function readViewedTip(userId: string | undefined, conversationId: string) {
  try { const k = key(userId); return k ? new Map(entries(k)).get(conversationId) : undefined } catch { return undefined }
}
export function saveViewedTip(userId: string | undefined, conversationId: string, tip: string) {
  try {
    const k = key(userId)
    if (!k) return
    const rows = entries(k).filter(([id]) => id !== conversationId)
    localStorage.setItem(k, JSON.stringify([...rows, [conversationId, tip]].slice(-100)))
  } catch { /* Optional navigation hint. */ }
}
