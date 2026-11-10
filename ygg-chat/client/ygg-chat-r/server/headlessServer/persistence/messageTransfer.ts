import type Database from 'better-sqlite3'
import { CLAUDE_TRANSFER_REFUSED, claudeTransferRefusal, type MessageTransferMeta, type TransferRow } from '../../../../../shared/claudeTransfer.js'
import { parseMessageMeta } from '../../../../../shared/contextInjection.js'

export interface TransferPayloadRow {
  source_id?: string
  parent_source_id?: string | null
  role?: string
  content?: unknown
  note?: unknown
  meta?: unknown
}

interface SourceRow extends TransferRow { id: string; conversation_id: string }

/** The selected source rows and all their ancestors, which decide whether a branch continues on Claude. */
export function loadTransferSourceRows(db: Database.Database, sourceIds: readonly string[]): Map<string, SourceRow> {
  if (!sourceIds.length) return new Map()
  const rows = db.prepare(`WITH RECURSIVE ancestry(id) AS (
    SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?)) UNION
    SELECT m.parent_id FROM messages m JOIN ancestry a ON m.id = a.id WHERE m.parent_id IS NOT NULL
  ) SELECT m.id, m.conversation_id, m.parent_id, m.role, m.content, m.note, m.meta FROM messages m JOIN ancestry a ON m.id = a.id`)
    .all(JSON.stringify(sourceIds)) as SourceRow[]
  return new Map(rows.map(row => [String(row.id), row]))
}

/** Refuse a selection whose Claude branches do not end at a committed summary. Unknown source ids use the payload. */
export function assertClaudeTransferable(payload: readonly TransferPayloadRow[], sources: ReadonlyMap<string, SourceRow>): void {
  const rows = new Map<string, TransferRow>(sources)
  const ids: string[] = []
  payload.forEach((row, index) => {
    const id = row.source_id != null ? String(row.source_id) : `__legacy_${index}`
    ids.push(id)
    if (!rows.has(id)) rows.set(id, { id, parent_id: row.parent_source_id ?? null, role: row.role, content: row.content, note: row.note, meta: row.meta })
  })
  const refusal = claudeTransferRefusal(rows.values(), ids)
  if (refusal) throw Object.assign(new Error(refusal), { status: 409, code: CLAUDE_TRANSFER_REFUSED })
}

/**
 * Copies get fresh ids and no native session, so metadata naming source rows, runs or sessions is
 * rewritten or dropped, and approval resets to the host default. `transfer` records provenance and
 * marks the row as having no Claude checkpoint.
 */
export function transferredMessageMeta(
  meta: unknown,
  sourceMessageId: string,
  sourceConversationId: string | null,
  idMap: ReadonlyMap<string, string>,
): string | null {
  const parsed = parseMessageMeta(meta)
  if (!parsed && typeof meta === 'string' && meta.trim()) return meta
  const next: Record<string, any> = { ...(parsed ?? {}) }
  delete next.toolAutoApprove
  if (next.claude && typeof next.claude === 'object') {
    const { checkpoint: _checkpoint, partial: _partial, ...claude } = next.claude
    next.claude = claude
  }
  const handoffId = next.executionHandoff?.summaryMessageId
  if (handoffId != null) {
    const mapped = idMap.get(String(handoffId))
    if (mapped) next.executionHandoff = { ...next.executionHandoff, summaryMessageId: mapped }
    else delete next.executionHandoff
  }
  if (next.sourceTipId != null) {
    const mapped = idMap.get(String(next.sourceTipId))
    if (mapped) next.sourceTipId = mapped
    else delete next.sourceTipId
  }
  // Keep copied rows of one run grouped (Heimdall hides a run's intermediate text by it), under an
  // id that cannot match a real run in the target chat, so no run footer attaches to the copies.
  if (typeof next.runStatistics?.streamId === 'string') {
    next.runStatistics = { ...next.runStatistics, streamId: `copied:${next.runStatistics.streamId}` }
  }
  const transfer: MessageTransferMeta = { sourceMessageId, ...(sourceConversationId ? { sourceConversationId } : {}) }
  next.transfer = transfer
  return JSON.stringify(next)
}
