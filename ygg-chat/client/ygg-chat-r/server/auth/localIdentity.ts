import type Database from 'better-sqlite3'
import { LOCAL_USER_ID, LOCAL_USER_NAME } from '../../../../shared/localUser.js'

/** The users row must exist before any project/conversation insert (foreign keys are on). */
export function ensureLocalUser(db: Database.Database): void {
  db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (?, ?)').run(LOCAL_USER_ID, LOCAL_USER_NAME)
}

const OWNED_TABLES = ['projects', 'conversations', 'provider_cost', 'note_search_docs'] as const

/**
 * One-time re-assignment of local data that a former Graviton (Supabase) sign-in moved to
 * that account's id, so previously signed-in users keep seeing their chats (fully-local
 * plan Q5). Plain UPDATEs in one transaction; the old users row is left in place so no
 * cascading delete can touch the data. Returns the number of rows moved.
 */
export function reassignLegacyAccountData(db: Database.Database, fromUserId: string): number {
  if (!fromUserId || fromUserId === LOCAL_USER_ID) return 0
  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name)
  )
  return db.transaction(() => {
    ensureLocalUser(db)
    let moved = 0
    for (const table of OWNED_TABLES) {
      if (!existing.has(table)) continue
      moved += db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(LOCAL_USER_ID, fromUserId).changes
    }
    return moved
  })()
}
