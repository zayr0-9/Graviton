import type Database from 'better-sqlite3'
import type { TranscriptRevision, TranscriptTextChange } from '../../../../../shared/transcriptRevision.js'

export const TRANSCRIPT_REVISION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS transcript_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lineage_id TEXT NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    changes_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_transcript_revisions_target
    ON transcript_revisions(lineage_id, message_id, id DESC);
`

type Row = { id: number; message_id: string; changes_json: string }
const deserialize = (row: Row): TranscriptRevision => ({
  id: row.id, messageId: row.message_id, changes: JSON.parse(row.changes_json) as TranscriptTextChange[],
})

/** A display-only revision stack. Provider and transcript queries still use the original rows. */
export class TranscriptRevisionRepo {
  constructor(private readonly db: Database.Database) {}

  latest(lineageId: string, messageId: string): TranscriptRevision | undefined {
    const row = this.db.prepare(`SELECT id, message_id, changes_json FROM transcript_revisions
      WHERE lineage_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1`).get(lineageId, messageId) as Row | undefined
    return row && deserialize(row)
  }

  list(lineageId: string): TranscriptRevision[] {
    return (this.db.prepare(`SELECT r.id, r.message_id, r.changes_json FROM transcript_revisions r
      JOIN (SELECT MAX(id) AS id FROM transcript_revisions WHERE lineage_id = ? GROUP BY message_id) visible
        ON visible.id = r.id`).all(lineageId) as Row[]).map(deserialize)
  }

  apply(conversationId: string, lineageId: string, messageId: string, expectedId: number | null, changes: TranscriptTextChange[], validate: () => void): number {
    return this.db.transaction(() => {
      validate()
      this.checkVersion(lineageId, messageId, expectedId)
      const { lastInsertRowid } = this.db.prepare(`INSERT INTO transcript_revisions(lineage_id, message_id, changes_json)
        VALUES (?, ?, ?)`).run(lineageId, messageId, JSON.stringify(changes))
      this.publish(conversationId, lineageId)
      return Number(lastInsertRowid)
    })()
  }

  undo(conversationId: string, lineageId: string, messageId: string, expectedId: number): void {
    this.db.transaction(() => {
      this.checkVersion(lineageId, messageId, expectedId)
      this.db.prepare('DELETE FROM transcript_revisions WHERE id = ?').run(expectedId)
      this.publish(conversationId, lineageId)
    })()
  }

  private checkVersion(lineageId: string, messageId: string, expectedId: number | null) {
    if ((this.latest(lineageId, messageId)?.id ?? null) !== expectedId) {
      throw new Error('This reply was revised elsewhere. Refresh and try again.')
    }
  }

  private publish(conversationId: string, lineageId: string) {
    this.db.prepare(`INSERT INTO client_changes(domain, entity_id, conversation_id)
      VALUES ('transcript_revisions', ?, ?)`).run(lineageId, conversationId)
    this.db.exec('DELETE FROM client_changes WHERE seq <= (SELECT MAX(seq) - 10000 FROM client_changes)')
  }
}
