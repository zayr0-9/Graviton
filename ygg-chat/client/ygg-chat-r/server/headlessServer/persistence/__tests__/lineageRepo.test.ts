import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LineageRepo } from '../lineageRepo.js'

let BetterSqlite3Ctor: (new (filename: string) => Database.Database) | null = null
try {
  const sqliteModule = await import('better-sqlite3')
  const candidate = sqliteModule.default as new (filename: string) => Database.Database
  const probe = new candidate(':memory:')
  probe.close()
  BetterSqlite3Ctor = candidate
} catch {
  BetterSqlite3Ctor = null
}
const describeIfSqlite = BetterSqlite3Ctor ? describe : describe.skip

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      lineage_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE lineages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_lineage_id TEXT,
      forked_from_message_id TEXT,
      root_message_id TEXT,
      head_message_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE fork_operations (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      source_lineage_id TEXT,
      target_lineage_id TEXT NOT NULL,
      source_message_id TEXT,
      materialized_message_id TEXT,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function createStatements(db: Database.Database): any {
  return {
    insertLineage: db.prepare(`INSERT INTO lineages
      (id, conversation_id, parent_lineage_id, forked_from_message_id, root_message_id, head_message_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getLineageById: db.prepare('SELECT * FROM lineages WHERE id = ?'),
    listLineagesByConversation: db.prepare('SELECT * FROM lineages WHERE conversation_id = ? ORDER BY created_at, id'),
    resolveLineageByMessage: db.prepare(`SELECT l.* FROM messages m JOIN lineages l ON l.id = m.lineage_id WHERE m.id = ?`),
    resolveAncestorLineageByMessage: db.prepare(`
      WITH RECURSIVE ancestors(id, parent_id, lineage_id, depth) AS (
        SELECT id, parent_id, lineage_id, 0 FROM messages WHERE id = ?
        UNION ALL
        SELECT m.id, m.parent_id, m.lineage_id, ancestors.depth + 1
        FROM messages m JOIN ancestors ON m.id = ancestors.parent_id WHERE ancestors.depth < 100
      )
      SELECT l.* FROM ancestors JOIN lineages l ON l.id = ancestors.lineage_id
      WHERE ancestors.lineage_id IS NOT NULL ORDER BY ancestors.depth LIMIT 1
    `),
    attachMessageToLineage: db.prepare(`UPDATE messages SET lineage_id = ? WHERE id = ? AND conversation_id = (SELECT conversation_id FROM lineages WHERE id = ?) AND (lineage_id IS NULL OR lineage_id = ?)`),
    advanceLineage: db.prepare(`UPDATE lineages SET root_message_id = COALESCE(root_message_id, ?), head_message_id = ?, status = ?, updated_at = ? WHERE id = ?`),
    insertForkOperation: db.prepare(`INSERT INTO fork_operations
      (id, conversation_id, source_lineage_id, target_lineage_id, source_message_id, materialized_message_id, operation, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getForkOperationById: db.prepare('SELECT * FROM fork_operations WHERE id = ?'),
    materializeForkOperation: db.prepare(`UPDATE fork_operations SET materialized_message_id = ?, status = 'materialized', updated_at = ? WHERE id = ? AND status = 'pending'`),
  }
}

describeIfSqlite('LineageRepo', () => {
  let db: Database.Database
  let repo: LineageRepo

  beforeEach(() => {
    if (!BetterSqlite3Ctor) throw new Error('better-sqlite3 unavailable')
    db = new BetterSqlite3Ctor(':memory:')
    createSchema(db)
    repo = new LineageRepo({ db, statements: createStatements(db) })
  })

  afterEach(() => db.close())

  const message = (id: string, parentId: string | null = null) =>
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, NULL, ?)').run(id, 'c1', parentId, new Date().toISOString())

  it('creates a UUID root and resolves it from the root message', () => {
    message('m1')
    const root = repo.createRoot({ conversationId: 'c1', rootMessageId: 'm1' })

    expect(root.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(root.root_message_id).toBe('m1')
    expect(root.head_message_id).toBe('m1')
    expect(repo.resolve({ messageId: 'm1' })?.id).toBe(root.id)
    expect(repo.list('c1')).toHaveLength(1)
  })

  it('records a pending fork then materializes it without changing parent_id', () => {
    message('m1')
    message('m2', 'm1')
    const root = repo.createRoot({ conversationId: 'c1', rootMessageId: 'm1' })
    const pending = repo.createPendingFork({
      conversationId: 'c1',
      sourceLineageId: root.id,
      sourceMessageId: 'm1',
      operation: 'edit-branch',
      metadata: { reason: 'edit' },
    })

    expect(pending.lineage.status).toBe('pending')
    expect(pending.lineage.parent_lineage_id).toBe(root.id)
    expect(pending.operation.status).toBe('pending')

    const materialized = repo.materialize(pending.operation.id, 'm2')
    expect(materialized.lineage.status).toBe('active')
    expect(materialized.lineage.root_message_id).toBe('m2')
    expect(materialized.operation.materialized_message_id).toBe('m2')
    expect((db.prepare('SELECT parent_id FROM messages WHERE id = ?').get('m2') as any).parent_id).toBe('m1')
  })

  it('appends content, advances the head, and preserves every parent_id', () => {
    message('m1')
    message('m2', 'm1')
    const root = repo.createRoot({ conversationId: 'c1', rootMessageId: 'm1' })
    const appended = repo.appendMessage(root.id, 'm2')

    expect(appended.root_message_id).toBe('m1')
    expect(appended.head_message_id).toBe('m2')
    expect(repo.resolve({ messageId: 'm2' })?.id).toBe(root.id)
    expect((db.prepare('SELECT parent_id FROM messages WHERE id = ?').get('m2') as any).parent_id).toBe('m1')
  })

  it('reconciles a legacy child to the nearest ancestor lineage', () => {
    message('m1')
    message('m2', 'm1')
    message('m3', 'm2')
    const root = repo.createRoot({ conversationId: 'c1', rootMessageId: 'm1' })
    const reconciled = repo.reconcile({ conversationId: 'c1', messageId: 'm3' })

    expect(reconciled.id).toBe(root.id)
    expect(reconciled.head_message_id).toBe('m3')
    expect((db.prepare('SELECT lineage_id FROM messages WHERE id = ?').get('m3') as any).lineage_id).toBe(root.id)
  })

  it('rolls back root and materialization writes when the message does not exist', () => {
    expect(() => repo.createRoot({ conversationId: 'c1', rootMessageId: 'missing' })).toThrow('Message not found')
    expect(repo.list('c1')).toEqual([])

    const pending = repo.createPendingFork({ conversationId: 'c1' })
    expect(() => repo.materialize(pending.operation.id, 'missing')).toThrow('Message not found')
    expect(repo.getForkOperation(pending.operation.id)?.status).toBe('pending')
    expect(repo.get(pending.lineage.id)?.status).toBe('pending')
  })
})


describeIfSqlite('LineageRepo legacy read reconciliation', () => {
  it('creates deterministic separate lineages for roots and secondary fork arms', () => {
    if (!BetterSqlite3Ctor) throw new Error('better-sqlite3 unavailable')
    const db = new BetterSqlite3Ctor(':memory:')
    try {
      createSchema(db)
      const repo = new LineageRepo({ db, statements: createStatements(db) })
      const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, NULL, ?)')
      insert.run('root-a', 'c1', null, '2024-01-01T00:00:00Z')
      insert.run('a-first', 'c1', 'root-a', '2024-01-02T00:00:00Z')
      insert.run('a-fork', 'c1', 'root-a', '2024-01-03T00:00:00Z')
      insert.run('root-b', 'c1', null, '2024-01-04T00:00:00Z')

      const first = repo.reconcileLegacyConversation('c1')
      expect(first.map(lineage => lineage.id).sort()).toEqual([
        'legacy:c1:a-fork', 'legacy:c1:root-a', 'legacy:c1:root-b',
      ])
      expect(repo.resolve({ messageId: 'a-first' })?.id).toBe('legacy:c1:root-a')
      expect(repo.resolve({ messageId: 'a-fork' })?.parent_lineage_id).toBe('legacy:c1:root-a')
      expect(repo.getDetail('c1', 'legacy:c1:a-fork')?.pathMessageIds).toEqual(['root-a', 'a-fork'])

      expect(repo.reconcileLegacyConversation('c1').map(lineage => lineage.id)).toEqual(first.map(lineage => lineage.id))
    } finally {
      db.close()
    }
  })
})
