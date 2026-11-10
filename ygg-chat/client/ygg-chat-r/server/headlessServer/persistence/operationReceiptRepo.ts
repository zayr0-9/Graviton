import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { RunAdmissionReceipt } from '../../../../../shared/runAdmission.js'

export const OPERATION_RECEIPT_SCHEMA = `CREATE TABLE IF NOT EXISTS operation_receipts (
  operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  epoch TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);`

export function operationFingerprint(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort()
      .filter(key => item[key] !== undefined).map(key => [key, canonical(item[key])])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/** Compact acceptance tombstones, not a second transcript or a replayable job queue. */
export class OperationReceiptRepo {
  constructor(private db: Database.Database) {}
  get(operationId: string): { fingerprint: string; receipt: RunAdmissionReceipt } | null {
    const row = this.db.prepare('SELECT fingerprint, receipt_json FROM operation_receipts WHERE operation_id=?').get(operationId) as any
    return row ? { fingerprint: row.fingerprint, receipt: JSON.parse(row.receipt_json) } : null
  }
  insert(fingerprint: string, receipt: RunAdmissionReceipt): void {
    this.db.prepare('INSERT INTO operation_receipts(operation_id,fingerprint,epoch,receipt_json,created_at) VALUES (?,?,?,?,?)')
      .run(receipt.operationId, fingerprint, receipt.epoch, JSON.stringify(receipt), new Date().toISOString())
  }
  update(receipt: RunAdmissionReceipt): void {
    const existing = this.get(receipt.operationId)?.receipt
    this.db.prepare('UPDATE operation_receipts SET receipt_json=? WHERE operation_id=?')
      .run(JSON.stringify({ ...receipt, ...(existing?.outcome ? { outcome: existing.outcome } : {}) }), receipt.operationId)
  }
  settleQueue(requestId: string, outcome: 'completed' | 'failed' | 'cancelled'): void {
    this.db.prepare(`UPDATE operation_receipts SET receipt_json=json_set(receipt_json,'$.outcome',?)
      WHERE operation_id=? AND json_extract(receipt_json,'$.disposition')='queued'`).run(outcome, requestId)
  }
  finishStream(streamId: string, outcome: 'completed' | 'failed' | 'cancelled'): void {
    this.db.prepare(`UPDATE operation_receipts SET receipt_json=json_set(receipt_json,'$.outcome',?)
      WHERE json_extract(receipt_json,'$.streamId')=? AND json_extract(receipt_json,'$.status')='accepted'
        AND json_extract(receipt_json,'$.disposition') IN ('started','restarted')`).run(outcome, streamId)
  }
  interruptPreviousEpoch(epoch: string): void {
    this.db.prepare(`UPDATE operation_receipts SET receipt_json=json_set(receipt_json,'$.status','interrupted')
      WHERE epoch <> ? AND json_extract(receipt_json,'$.status')='accepted' AND json_extract(receipt_json,'$.outcome') IS NULL`).run(epoch)
  }
}
