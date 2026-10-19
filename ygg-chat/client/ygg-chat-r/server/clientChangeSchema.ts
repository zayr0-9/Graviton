import type Database from 'better-sqlite3'

export const CLIENT_CHANGE_SCHEMA = `CREATE TABLE IF NOT EXISTS client_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  conversation_id TEXT,
  revision INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);`

/** Transactional outbox: rollback rolls back notifications; all SQL writers participate.
 * No transcript text, credentials, or per-token events are retained here. */
export function installClientChangeSchema(db: Database.Database): void {
  db.exec(CLIENT_CHANGE_SCHEMA)
  for (const table of ['messages', 'conversations', 'projects']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!columns.length) throw new Error(`Missing change-feed table: ${table}`)
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW'
      const conversation = table === 'messages' ? `${row}.conversation_id` : table === 'conversations' ? `${row}.id` : 'NULL'
      const revision = table === 'messages' ? `${row}.revision` : 'NULL'
      // Message revision trigger is the sole update publisher: avoid duplicates
      // and ensure events reference the committed revision, not pre-trigger state.
      const guard = operation === 'UPDATE' ? table === 'messages'
        ? 'WHEN OLD.revision IS NOT NEW.revision'
        : `WHEN ${columns.map(({ name }) => `OLD."${name}" IS NOT NEW."${name}"`).join(' OR ')}` : ''
      db.exec(`CREATE TRIGGER IF NOT EXISTS client_changes_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} ${guard}
        BEGIN
          INSERT INTO client_changes(domain,entity_id,conversation_id,revision,deleted)
          VALUES ('${table}',${row}.id,${conversation},${revision},${operation === 'DELETE' ? 1 : 0});
          DELETE FROM client_changes WHERE seq <= (SELECT MAX(seq) - 10000 FROM client_changes);
        END;`)
    }
  }
}
