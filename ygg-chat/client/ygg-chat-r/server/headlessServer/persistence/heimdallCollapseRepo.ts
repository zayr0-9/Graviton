import type Database from 'better-sqlite3'

/**
 * Heimdall collapse groups: a per-conversation, visual-only tree-management aid.
 * Each row stores the message ids one collapse node hides. Messages, ancestry and
 * paths are never changed. Rows cascade with their conversation; ids of messages
 * deleted later are filtered out on read and write instead of rewriting rows.
 */
export const HEIMDALL_COLLAPSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS heimdall_collapse_groups (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_ids TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_heimdall_collapse_groups_conversation
  ON heimdall_collapse_groups(conversation_id, position);
`

export interface HeimdallCollapseGroupRecord {
  id: string
  memberIds: string[]
}

export const HEIMDALL_COLLAPSE_LIMITS = {
  groups: 2_000,
  idLength: 200,
  membersPerGroup: 100_000,
} as const

export class HeimdallCollapseValidationError extends Error {}

/** Shape-check an untrusted request body. Throws a validation error on bad input. */
export function parseHeimdallCollapseGroups(value: unknown): HeimdallCollapseGroupRecord[] {
  if (!Array.isArray(value)) throw new HeimdallCollapseValidationError('groups must be an array')
  if (value.length > HEIMDALL_COLLAPSE_LIMITS.groups) throw new HeimdallCollapseValidationError('too many groups')
  const seen = new Set<string>()
  return value.map(item => {
    const group = item as Partial<HeimdallCollapseGroupRecord> | null
    if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !group.id ||
      group.id.length > HEIMDALL_COLLAPSE_LIMITS.idLength) {
      throw new HeimdallCollapseValidationError('each group needs a string id')
    }
    if (seen.has(group.id)) throw new HeimdallCollapseValidationError('duplicate group id')
    seen.add(group.id)
    if (!Array.isArray(group.memberIds) || group.memberIds.length > HEIMDALL_COLLAPSE_LIMITS.membersPerGroup ||
      !group.memberIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= HEIMDALL_COLLAPSE_LIMITS.idLength)) {
      throw new HeimdallCollapseValidationError('memberIds must be an array of message ids')
    }
    return { id: group.id, memberIds: [...new Set(group.memberIds)] }
  })
}

export class HeimdallCollapseRepo {
  constructor(private readonly db: Database.Database) {}

  conversationExists(conversationId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId))
  }

  private messageIds(conversationId: string): Set<string> {
    const rows = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(conversationId) as { id: string }[]
    return new Set(rows.map(row => String(row.id)))
  }

  /** Keep only ids of this conversation's live messages; a group needs two to mean anything. */
  private prune(groups: HeimdallCollapseGroupRecord[], known: Set<string>): HeimdallCollapseGroupRecord[] {
    return groups
      .map(group => ({ id: group.id, memberIds: group.memberIds.filter(id => known.has(id)) }))
      .filter(group => group.memberIds.length >= 2)
  }

  list(conversationId: string): HeimdallCollapseGroupRecord[] {
    const rows = this.db.prepare(
      'SELECT id, member_ids FROM heimdall_collapse_groups WHERE conversation_id = ? ORDER BY position, created_at, id'
    ).all(conversationId) as { id: string; member_ids: string }[]
    const groups = rows.flatMap(row => {
      try {
        const memberIds: unknown = JSON.parse(row.member_ids)
        return Array.isArray(memberIds) ? [{ id: row.id, memberIds: memberIds.filter((id): id is string => typeof id === 'string') }] : []
      } catch {
        return []
      }
    })
    return groups.length ? this.prune(groups, this.messageIds(conversationId)) : []
  }

  /** Replace the conversation's whole group set atomically; returns what was stored. */
  replace(conversationId: string, groups: HeimdallCollapseGroupRecord[]): HeimdallCollapseGroupRecord[] {
    const stored = this.prune(groups, this.messageIds(conversationId))
    const now = new Date().toISOString()
    const remove = this.db.prepare('DELETE FROM heimdall_collapse_groups WHERE conversation_id = ?')
    // A group id belongs to one conversation; never let a write move another conversation's row.
    const insert = this.db.prepare(`
      INSERT INTO heimdall_collapse_groups (id, conversation_id, member_ids, position, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET member_ids = excluded.member_ids, position = excluded.position
      WHERE heimdall_collapse_groups.conversation_id = excluded.conversation_id
    `)
    this.db.transaction(() => {
      remove.run(conversationId)
      stored.forEach((group, position) => insert.run(group.id, conversationId, JSON.stringify(group.memberIds), position, now))
    })()
    return this.list(conversationId)
  }
}
