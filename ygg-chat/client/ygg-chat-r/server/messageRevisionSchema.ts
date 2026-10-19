import type Database from 'better-sqlite3'

/** SQLite owns revisions so direct SQL, cloud mirrors and background writers agree.
 * UPDATE OF excludes revision itself, even with recursive_triggers enabled. */
export function installMessageRevisions(database: Database.Database): void {
  const columns = database.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
  if (!columns.some(column => column.name === 'revision')) {
    database.exec('ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
  }
  const names = columns.map(column => column.name).filter(name => name !== 'revision')
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
  database.exec(`CREATE TRIGGER IF NOT EXISTS messages_revision_update
    AFTER UPDATE OF ${names.map(quote).join(', ')} ON messages
    WHEN ${names.map(name => `OLD.${quote(name)} IS NOT NEW.${quote(name)}`).join(' OR ')}
    BEGIN
      UPDATE messages SET revision = COALESCE(OLD.revision, 0) + 1 WHERE id = NEW.id;
    END;`)
}
