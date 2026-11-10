import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { DECISION_RECEIPT_SCHEMA, DecisionReceiptRepo, installDecisionReceiptSchema } from '../headlessServer/persistence/decisionReceiptRepo.js'
import { DecisionBroker } from '../headlessServer/services/decisionBroker.js'
it('recognizes a settled answer after broker restart without recreating a waiter', async () => {
  const db = new Database(':memory:')
  try {
    db.exec(DECISION_RECEIPT_SCHEMA)
    db.exec(DECISION_RECEIPT_SCHEMA) // Fresh schema and migration converge.
    const store = new DecisionReceiptRepo(db)
    const first = new DecisionBroker(store)
    const pending = first.requestDecision({ streamId: 's', toolCallId: 't', kind: 'clarify' })
    expect(first.resolve('s', 't', { answers: [{ question: 'private', answer: 'secret answer' }] })).toBe(true)
    await pending
    const restarted = new DecisionBroker(store)
    expect(restarted.resolve('s', 't', { answers: [{ answer: 'secret answer', question: 'private' }] })).toBe(true)
    expect(restarted.resolve('s', 't', { cancelled: true })).toBe(false)
    expect(restarted.receipt('s', 't')?.outcome).toBe('resolved')
    await expect(restarted.requestDecision({ streamId: 's', toolCallId: 't', kind: 'clarify' })).rejects.toThrow('already settled')
    expect(JSON.stringify(db.prepare('SELECT * FROM decision_receipts').all())).not.toContain('secret answer')
  } finally { db.close() }
})

it('upgrades a stamped prototype receipt table without deleting old outcomes', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE decision_receipts(stream_id TEXT, tool_call_id TEXT, fingerprint TEXT, event_json TEXT, PRIMARY KEY(stream_id,tool_call_id))')
    const event = { type: 'decision_settled', streamId: 's', toolCallId: 't', outcome: 'resolved', revision: 1 }
    db.prepare('INSERT INTO decision_receipts VALUES (?,?,?,?)').run('s', 't', 'hash', JSON.stringify(event))
    db.pragma('user_version = 10')
    installDecisionReceiptSchema(db); installDecisionReceiptSchema(db)
    expect(new DecisionReceiptRepo(db).get('s', 't', 'any')?.event).toEqual(event)
  } finally { db.close() }
})
