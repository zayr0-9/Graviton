import type Database from 'better-sqlite3'
import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
export type DecisionSettlement = Extract<HeadlessStreamEvent, { type: 'decision_settled' }>
export const DECISION_RECEIPT_SCHEMA = `CREATE TABLE IF NOT EXISTS decision_receipts (
  stream_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT,
  event_json TEXT NOT NULL,
  PRIMARY KEY(stream_id, tool_call_id, kind)
);`
export function installDecisionReceiptSchema(db: Database.Database): void {
  db.exec(DECISION_RECEIPT_SCHEMA)
  const columns = db.prepare('PRAGMA table_info(decision_receipts)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'kind')) {
    // Preserve unshipped prototype receipts as wildcard legacy outcomes; never
    // make an old answer executable merely to upgrade the table shape.
    db.transaction(() => {
      db.exec('ALTER TABLE decision_receipts RENAME TO decision_receipts_legacy')
      db.exec(DECISION_RECEIPT_SCHEMA)
      db.exec("INSERT INTO decision_receipts(stream_id,tool_call_id,kind,fingerprint,event_json) SELECT stream_id,tool_call_id,'any',fingerprint,event_json FROM decision_receipts_legacy")
      db.exec('DROP TABLE decision_receipts_legacy')
    })()
  }
}
export interface DecisionReceiptStore {
  get(streamId: string, toolCallId: string, kind: string): { fingerprint: string | null; event: DecisionSettlement } | undefined
  save(event: DecisionSettlement, fingerprint: string | null, kind: string): void
}
/** Only hashes and settlement metadata survive restart; no permission answers,
 * tool arguments or clarification text are persisted in this ledger. */
export class DecisionReceiptRepo implements DecisionReceiptStore {
  constructor(private db: Database.Database) {}
  get(streamId: string, toolCallId: string, kind: string) {
    try {
      const row = this.db.prepare('SELECT fingerprint,event_json FROM decision_receipts WHERE stream_id=? AND tool_call_id=? AND kind=?').get(streamId, toolCallId, kind) as any
      return row ? { fingerprint: row.fingerprint as string | null, event: JSON.parse(row.event_json) as DecisionSettlement } : undefined
    } catch {
      console.warn('[DecisionReceiptRepo] Durable receipt could not be read; live broker remains authoritative')
      return undefined
    }
  }
  save(event: DecisionSettlement, fingerprint: string | null, kind: string): void {
    this.db.prepare('INSERT OR IGNORE INTO decision_receipts(stream_id,tool_call_id,fingerprint,event_json,kind) VALUES (?,?,?,?,?)')
      .run(event.streamId, event.toolCallId, fingerprint, JSON.stringify(event), kind)
  }
}
