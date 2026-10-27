import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteMessagesWithLineageRepair, withMessageDeletionLock } from '../deleteMessages.js'
import { LineageRepo } from '../lineageRepo.js'
import { ChatOrchestrator } from '../../services/chatOrchestrator.js'

describe('cascading message deletion', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      children_ids TEXT DEFAULT '[]', lineage_id TEXT);
      CREATE TABLE lineages (id TEXT PRIMARY KEY, conversation_id TEXT, head_message_id TEXT, root_message_id TEXT,
        forked_from_message_id TEXT, status TEXT, updated_at TEXT);
      CREATE TABLE streaming_runs (parent_message_id TEXT, lineage_id TEXT, status TEXT, source TEXT DEFAULT 'headless');
      CREATE TABLE changes (id TEXT);
      CREATE TRIGGER deletion_changes AFTER DELETE ON messages BEGIN INSERT INTO changes VALUES (OLD.id); END;
      INSERT INTO messages VALUES ('u', 'c', NULL, '["a","sibling"]', 'l');
      INSERT INTO messages VALUES ('a', 'c', 'u', '["child"]', 'l');
      INSERT INTO messages VALUES ('child', 'c', 'a', '[]', 'fork');
      INSERT INTO messages VALUES ('sibling', 'c', 'u', '[]', 'sibling-l');
      INSERT INTO lineages VALUES ('l', 'c', 'a', 'u', NULL, 'active', 'before');
      INSERT INTO lineages VALUES ('fork', 'c', 'child', 'child', 'a', 'active', 'before');
      INSERT INTO lineages VALUES ('sibling-l', 'c', 'sibling', 'sibling', 'u', 'active', 'before');`)
  })
  afterEach(() => db.close())
  const lineage = (id: string) => db.prepare('SELECT * FROM lineages WHERE id = ?').get(id) as any

  it('repairs all cascaded heads without reassigning ownership or touching a sibling, and admits the next send', () => {
    deleteMessagesWithLineageRepair(db, ['a'])
    expect(lineage('l').head_message_id).toBe('u')
    expect(lineage('fork')).toMatchObject({ head_message_id: 'u', root_message_id: null, forked_from_message_id: 'u', status: 'active' })
    expect(lineage('sibling-l')).toMatchObject({ head_message_id: 'sibling', updated_at: 'before' })
    expect(db.prepare('SELECT children_ids FROM messages WHERE id = ?').get('u')).toEqual({ children_ids: '["sibling"]' })
    expect(db.prepare('SELECT id FROM changes ORDER BY id').all()).toEqual([{ id: 'a' }, { id: 'child' }])
    const repo = new LineageRepo({ db, statements: { getLineageById: db.prepare('SELECT * FROM lineages WHERE id = ?') } })
    const host = Object.create(ChatOrchestrator.prototype) as any
    host.lineageRepo = repo
    host.inputRuns = new Map()
    host.conversationRepo = { getById: () => ({}), getMessageById: (id: string) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id),
      listMessages: () => db.prepare('SELECT * FROM messages').all() }
    expect(host.classifyOrdinarySend({ conversationId: 'c', lineageId: 'fork', parentId: 'u' })).toEqual({ lineageId: 'fork', parentId: 'u' })
    deleteMessagesWithLineageRepair(db, ['a']) // Mirror retry must not rewind again.
    expect(lineage('fork').head_message_id).toBe('u')
  })

  it('walks over overlapping bulk deletions to the nearest surviving ancestor', () => {
    deleteMessagesWithLineageRepair(db, ['a', 'child', 'a'])
    expect(lineage('fork').head_message_id).toBe('u')
    expect(db.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([{ id: 'sibling' }, { id: 'u' }])
  })

  it('retains empty lineage identity without a dangling root/head', () => {
    deleteMessagesWithLineageRepair(db, ['u'])
    expect(lineage('l')).toMatchObject({ head_message_id: null, root_message_id: null, status: 'pending' })
    expect(lineage('fork')).toMatchObject({ head_message_id: null, root_message_id: null, forked_from_message_id: null, status: 'pending' })
  })

  it('rejects deletion of running ancestry but permits unrelated branches', () => {
    db.prepare('INSERT INTO streaming_runs (parent_message_id, lineage_id, status) VALUES (?, ?, ?)').run('u', 'fork', 'running')
    expect(() => deleteMessagesWithLineageRepair(db, ['a'])).toThrow('Wait for this branch')
    expect(lineage('l').head_message_id).toBe('a')
    expect(db.prepare('SELECT id FROM messages WHERE id = ?').get('a')).toBeTruthy()
    deleteMessagesWithLineageRepair(db, ['sibling'])
    expect(lineage('sibling-l').head_message_id).toBe('u')
  })

  it('ignores stale legacy renderer runs', () => {
    db.prepare('INSERT INTO streaming_runs VALUES (?, ?, ?, ?)').run('u', 'fork', 'running', 'renderer')
    deleteMessagesWithLineageRepair(db, ['a'])
    expect(lineage('fork').head_message_id).toBe('u')
  })

  it('blocks admission throughout an awaited cloud deletion and releases the lock on failure', async () => {
    const host = Object.create(ChatOrchestrator.prototype) as any
    host.db = db
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const deleting = withMessageDeletionLock(db, ['a'], async () => {
      await waiting
      deleteMessagesWithLineageRepair(db, ['a'])
    })
    expect(() => host.validateExecutionSelection({ conversationId: 'c' })).toThrow('deletion is in progress')
    release(); await deleting
    expect(lineage('l').head_message_id).toBe('u')
    await expect(withMessageDeletionLock(db, ['u'], async () => { throw new Error('Cloud failed') })).rejects.toThrow('Cloud failed')
    // Admission now reaches normal execution validation rather than the deletion fence.
    host.conversationRepo = { listPathToMessage: () => [] }
    host.inputRuns = new Map()
    expect(() => host.validateExecutionSelection({ conversationId: 'c', provider: 'test' })).not.toThrow()
  })

  it('rolls back messages, child links and lineage metadata if a repair fails', () => {
    db.exec(`CREATE TRIGGER fail_repair BEFORE UPDATE ON lineages BEGIN SELECT RAISE(ABORT, 'repair failed'); END;`)
    expect(() => deleteMessagesWithLineageRepair(db, ['a'])).toThrow('repair failed')
    expect(db.prepare('SELECT id FROM messages WHERE id = ?').get('child')).toBeTruthy()
    expect(lineage('l').head_message_id).toBe('a')
    expect(db.prepare('SELECT children_ids FROM messages WHERE id = ?').get('u')).toEqual({ children_ids: '["a","sibling"]' })
    expect(db.prepare('SELECT * FROM changes').all()).toEqual([])
  })
})
