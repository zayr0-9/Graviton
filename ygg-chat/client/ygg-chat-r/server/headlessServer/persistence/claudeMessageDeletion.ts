import type Database from 'better-sqlite3'
import { isRunSettingsNotification } from '../../../../../shared/accessNotifications.js'
import { isClaudeTranscriptMessage } from '../../../../../shared/claudeProvider.js'
import { isContextInjectionMessage } from '../../../../../shared/contextInjection.js'

interface Row { id: string; parent_id: string | null; role: string; meta: string | null }

export const CLAUDE_DELETE_REFUSED = 'claude_delete_refused'

const hasTable = (db: Database.Database, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))

/** Launch context and settings notices belong to the prompt below them, as in `isCleanStartUserBranch`. */
const isScaffolding = (row: Row): boolean =>
  (row.role === 'user' || row.role === 'system') && (isContextInjectionMessage(row) || isRunSettingsNotification(row))

/**
 * Resolve which rows a delete removes. Deletion cascades, so it truncates a branch at each
 * requested row. A Claude branch continues only from a completed response checkpoint (native
 * forkSession), so a cut must land on one, on the conversation root, or beside a surviving
 * sibling, as Claude Code's rewind does. Launch scaffolding owned only by the cut is removed
 * with it. Requests without Claude rows are returned unchanged.
 */
export function planMessageDeletion(db: Database.Database, ids: readonly string[]): string[] {
  const subtree = db.prepare(`WITH RECURSIVE subtree(id) AS (
    SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?)) UNION
    SELECT m.id FROM messages m JOIN subtree s ON m.parent_id = s.id
  ) SELECT m.id, m.parent_id, m.role, m.meta FROM messages m JOIN subtree s ON m.id = s.id`)
    .all(JSON.stringify(ids)) as Row[]
  if (!subtree.some(isClaudeTranscriptMessage)) return [...ids]

  const deleted = new Set(subtree.map(row => row.id))
  const getRow = db.prepare('SELECT id, parent_id, role, meta FROM messages WHERE id = ?')
  const childIds = db.prepare('SELECT id FROM messages WHERE parent_id = ?')
  const resumable = hasTable(db, 'claude_message_checkpoints')
    ? db.prepare('SELECT 1 FROM claude_message_checkpoints WHERE message_id = ? AND resumable = 1')
    : null
  const parentOf = (row: Row) => row.parent_id ? getRow.get(row.parent_id) as Row | undefined : undefined
  const survivingChildren = (id: string) => (childIds.all(id) as Array<{ id: string }>).filter(child => !deleted.has(child.id))
  const rootScaffolding = (row: Row | undefined): boolean => {
    const seen = new Set<string>()
    for (; row && isScaffolding(row) && !seen.has(row.id); row = parentOf(row)) {
      seen.add(row.id)
      if (!row.parent_id) return true
    }
    return false
  }

  const planned = new Set(ids)
  // Rows below another requested row are removed by its cascade; only the cuts need checking.
  for (const row of subtree.filter(row => !row.parent_id || !deleted.has(row.parent_id))) {
    let top = row
    for (let parent = parentOf(top); parent && !deleted.has(parent.id) && isScaffolding(parent) &&
      survivingChildren(parent.id).length === 0; parent = parentOf(parent)) {
      top = parent
      deleted.add(parent.id)
      planned.add(parent.id)
    }
    const anchor = parentOf(top)
    if (!anchor || resumable?.get(anchor.id) || rootScaffolding(anchor) || survivingChildren(anchor.id).length > 0) continue
    throw Object.assign(new Error('Claude can only continue from a completed response. Delete from the user message after one instead.'),
      { status: 409, code: CLAUDE_DELETE_REFUSED })
  }
  return [...planned]
}
