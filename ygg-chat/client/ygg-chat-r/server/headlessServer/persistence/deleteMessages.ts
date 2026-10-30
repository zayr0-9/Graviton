import type Database from 'better-sqlite3'

interface MessageRow { id: string; conversation_id: string; parent_id: string | null; children_ids: string }
interface LineageRow {
  id: string; conversation_id: string; head_message_id: string | null; root_message_id: string | null
  forked_from_message_id: string | null; status: string
}
const hasTable = (db: Database.Database, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

const deletionLocks = new WeakMap<Database.Database, Set<string>>()

export function assertConversationNotDeleting(db: Database.Database, conversationId: string): void {
  if (deletionLocks.get(db)?.has(conversationId)) {
    throw Object.assign(new Error('Message deletion is in progress. Wait before sending again.'), { status: 409, code: 'run_unavailable' })
  }
}

/** Cloud authority and its local mirror must settle before another run is admitted. */
export async function withMessageDeletionLock<T>(db: Database.Database, ids: readonly string[], operation: () => Promise<T>): Promise<T> {
  const conversations = db.prepare(`SELECT DISTINCT conversation_id FROM messages WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as Array<{ conversation_id: string }>
  for (const row of conversations) assertConversationNotDeleting(db, row.conversation_id)
  const locked = deletionLocks.get(db) ?? new Set<string>()
  deletionLocks.set(db, locked)
  for (const row of conversations) locked.add(row.conversation_id)
  try { return await operation() }
  finally { for (const row of conversations) locked.delete(row.conversation_id) }
}

function deletionRows(db: Database.Database, ids: readonly string[]): MessageRow[] {
  return db.prepare(`WITH RECURSIVE subtree(id) AS (
    SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?)) UNION
    SELECT m.id FROM messages m JOIN subtree s ON m.parent_id = s.id
  ) SELECT m.id, m.conversation_id, m.parent_id, m.children_ids FROM messages m JOIN subtree s ON m.id = s.id`)
    .all(JSON.stringify(ids)) as MessageRow[]
}

/** A running branch must settle before its durable ancestry can be removed. */
export function assertMessagesNotInActiveRun(db: Database.Database, ids: readonly string[]): void {
  if (!hasTable(db, 'streaming_runs')) return
  const deleted = new Set(deletionRows(db, ids).map(row => row.id))
  if (!deleted.size) return
  const runs = db.prepare(`SELECT parent_message_id, lineage_id FROM streaming_runs
    WHERE status = 'running' AND source = 'headless'`).all() as Array<{ parent_message_id: string | null; lineage_id: string | null }>
  const lineages = hasTable(db, 'lineages')
    ? new Map((db.prepare('SELECT id, head_message_id FROM lineages').all() as LineageRow[]).map(row => [row.id, row.head_message_id]))
    : new Map<string, string | null>()
  if (runs.some(run => deleted.has(run.parent_message_id ?? '') || deleted.has(lineages.get(run.lineage_id ?? '') ?? ''))) {
    throw Object.assign(new Error('Wait for this branch run to finish before deleting its messages.'), { status: 409 })
  }
}

/** Delete the same cascading subtree as SQLite, repairing heads and child links atomically.
 * Empty forks retain their identity and surviving shared ancestor; message ownership is never reassigned.
 */
export function deleteMessagesWithLineageRepair(db: Database.Database, ids: readonly string[]): void {
  db.transaction(() => {
    assertMessagesNotInActiveRun(db, ids)
    const deletedRows = deletionRows(db, ids)
    if (!deletedRows.length) return // Idempotent mirror/retry.
    const deleted = new Map(deletedRows.map(row => [row.id, row]))
    const lineages = hasTable(db, 'lineages') ? db.prepare('SELECT * FROM lineages').all() as LineageRow[] : []
    const repairs = lineages.filter(row => deleted.has(row.head_message_id ?? '') ||
      deleted.has(row.root_message_id ?? '') || deleted.has(row.forked_from_message_id ?? '')).map(row => {
      let head = row.head_message_id
      const seen = new Set<string>()
      while (head && deleted.has(head) && !seen.has(head)) {
        seen.add(head)
        head = deleted.get(head)!.parent_id
      }
      if (head && deleted.has(head)) head = null
      return { ...row, head_message_id: head,
        root_message_id: deleted.has(row.root_message_id ?? '') ? null : row.root_message_id,
        forked_from_message_id: deleted.has(row.forked_from_message_id ?? '') ? head : row.forked_from_message_id,
        status: row.status === 'archived' ? 'archived' : head == null ? 'pending' : row.status }
    })
    const remove = db.prepare('DELETE FROM messages WHERE id = ?')
    for (const id of ids) remove.run(id)
    // Only boundary parents survive a cascade. Preserve their existing sibling order.
    const parentIds = new Set(deletedRows.map(row => row.parent_id).filter((id): id is string => id != null && !deleted.has(id)))
    const parentRow = db.prepare('SELECT children_ids FROM messages WHERE id = ?')
    const updateChildren = db.prepare('UPDATE messages SET children_ids = ? WHERE id = ?')
    for (const id of parentIds) {
      const parent = parentRow.get(id) as { children_ids: string } | undefined
      if (!parent) continue
      const children = JSON.parse(parent.children_ids || '[]') as string[]
      updateChildren.run(JSON.stringify(children.filter(child => !deleted.has(String(child)))), id)
    }
    if (repairs.length) {
      const update = db.prepare(`UPDATE lineages SET head_message_id = ?, root_message_id = ?,
        forked_from_message_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      const now = new Date().toISOString()
      for (const row of repairs) update.run(row.head_message_id, row.root_message_id, row.forked_from_message_id, row.status, now, row.id)
      // An emptied Claude branch has no checkpoint to resume; its next prompt starts a fresh session.
      if (hasTable(db, 'claude_branch_sessions')) {
        const reset = db.prepare('DELETE FROM claude_branch_sessions WHERE lineage_id = ?')
        for (const row of repairs) if (row.head_message_id == null) reset.run(row.id)
      }
    }
  })()
}
