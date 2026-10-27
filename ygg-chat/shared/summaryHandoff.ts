import { isCommittedCompaction } from './compaction.js'

/** A handoff copies only committed summary text, never a provider's native session. */
export function portableSummaryText(message: any): string | null {
  if (!isCommittedCompaction(message)) return null
  const text = message?.content ?? message?.plain_text_content ?? message?.content_plain_text
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

/** Provider identity resets only at a persisted, explicitly accepted handoff row. */
export function executionPathAfterHandoff<T extends { id?: unknown; meta?: unknown }>(path: T[]): T[] {
  for (let index = path.length - 1; index >= 0; index--) {
    let meta: any = path[index].meta
    if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { continue } }
    const summaryId = meta?.executionHandoff?.summaryMessageId
    if (summaryId && path.slice(0, index).some(row => String(row.id) === String(summaryId) && portableSummaryText(row))) return path.slice(index)
  }
  return path
}
