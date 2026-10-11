import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOTE_SEARCH_SCHEMA_SQL,
  NOTE_SEARCH_TABLES_SQL,
  NOTE_SEARCH_TRIGGER_NAMES,
  rebuildSearchIndexes,
} from '../searchIndexSchema.js'
import {
  TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL,
  TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES,
} from '../topLevelUserMessages.js'

const require = createRequire(import.meta.url)

function openDatabase(): any {
  try {
    const Database = require('better-sqlite3')
    return new Database(':memory:')
  } catch {
    // Electron's native addon may not load under Node; node:sqlite runs the same SQL.
    const { DatabaseSync } = require('node:sqlite')
    return new DatabaseSync(':memory:')
  }
}

const BASE_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL);
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT NOT NULL, title TEXT,
    storage_mode TEXT NOT NULL DEFAULT 'local', updated_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL,
    content TEXT NOT NULL, plain_text_content TEXT, note TEXT, meta TEXT, children_ids TEXT DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  INSERT INTO users VALUES ('user-1', 'user-1');
  INSERT INTO conversations (id, project_id, user_id, title, updated_at)
    VALUES ('conv-1', 'project-1', 'user-1', 'Title one', '2026-10-01');
  INSERT INTO conversations (id, project_id, user_id, title, updated_at)
    VALUES ('conv-2', 'project-1', 'user-1', 'Title two', '2026-10-01');
`

const OLD_STAMP = '2026-01-02 03:04:05'

describe('search index schema', () => {
  let db: any

  const addMessage = (id: string, conversationId: string, options: {
    parentId?: string | null; role?: string; note?: string | null
  } = {}) => {
    db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, plain_text_content, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, conversationId, options.parentId ?? null, options.role ?? 'user', id, `plain ${id}`, options.note ?? null)
  }
  const docs = () => db.prepare(
    'SELECT rowid, message_id, conversation_title, note, note_updated_at FROM note_search_docs ORDER BY message_id'
  ).all()
  const noteFts = () => db.prepare('SELECT rowid, message_id FROM note_search_fts ORDER BY message_id').all()
  const topFts = () => db.prepare('SELECT rowid, message_id FROM top_level_user_message_search ORDER BY message_id').all()
  const noteMatch = (query: string) => db.prepare(
    'SELECT message_id FROM note_search_fts WHERE note_search_fts MATCH ? ORDER BY message_id'
  ).all(query).map((row: any) => row.message_id)
  const triggerNames = (prefix: string) => db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name`
  ).all(`${prefix}%`).map((row: any) => row.name)
  const ids = (rows: any[]) => rows.map(row => row.message_id)
  const stampOf = (messageId: string) => docs().find((row: any) => row.message_id === messageId).note_updated_at

  beforeEach(() => {
    db = openDatabase()
    db.exec(BASE_SCHEMA)
  })

  afterEach(() => {
    db.close()
  })

  it('keeps note docs and the note index aligned by rowid through edits, clears, and deletes', () => {
    db.exec(NOTE_SEARCH_SCHEMA_SQL)
    addMessage('m1', 'conv-1', { note: 'alpha note' })
    addMessage('m2', 'conv-1', { parentId: 'm1', role: 'assistant' })
    addMessage('m3', 'conv-1', { parentId: 'm2', note: 'beta note' })
    addMessage('m4', 'conv-1', { parentId: 'm3', role: 'assistant', note: '   ' })
    expect(ids(docs())).toEqual(['m1', 'm3'])
    expect(noteFts()).toEqual(docs().map((row: any) => ({ rowid: row.rowid, message_id: row.message_id })))
    expect(noteMatch('alpha')).toEqual(['m1'])

    db.prepare('UPDATE messages SET note = ? WHERE id = ?').run('gamma note', 'm1')
    expect(noteMatch('alpha')).toEqual([])
    expect(noteMatch('gamma')).toEqual(['m1'])
    expect(noteFts()).toEqual(docs().map((row: any) => ({ rowid: row.rowid, message_id: row.message_id })))

    db.prepare('UPDATE messages SET note = NULL WHERE id = ?').run('m3')
    expect(ids(docs())).toEqual(['m1'])
    expect(ids(noteFts())).toEqual(['m1'])

    db.prepare('DELETE FROM messages WHERE id = ?').run('m1')
    expect(docs()).toEqual([])
    expect(noteFts()).toEqual([])
    expect(db.prepare('SELECT count(*) AS n FROM note_search_embedding_state').get().n).toBe(0)
  })

  it('ignores conversation touches and keeps note_updated_at when conversation fields change', () => {
    db.exec(NOTE_SEARCH_SCHEMA_SQL)
    addMessage('m1', 'conv-1', { note: 'alpha note' })
    db.prepare('UPDATE note_search_docs SET note_updated_at = ? WHERE message_id = ?').run(OLD_STAMP, 'm1')

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2026-10-11', 'conv-1')
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('Title one', 'conv-1')
    expect(docs()[0]).toMatchObject({ conversation_title: 'Title one', note_updated_at: OLD_STAMP })

    db.prepare('UPDATE conversations SET title = ?, project_id = ? WHERE id = ?').run('Renamed', 'project-2', 'conv-1')
    expect(docs()[0]).toMatchObject({ conversation_title: 'Renamed', note_updated_at: OLD_STAMP })
    expect(db.prepare('SELECT project_id FROM note_search_docs WHERE message_id = ?').get('m1').project_id).toBe('project-2')
    expect(noteMatch('renamed')).toEqual(['m1'])
    expect(noteMatch('title')).toEqual([])
  })

  it('boot schema SQL is create-only and safe to run again', () => {
    db.exec(NOTE_SEARCH_SCHEMA_SQL)
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('m1', 'conv-1', { note: 'alpha note' })
    db.prepare('UPDATE note_search_docs SET note_updated_at = ? WHERE message_id = ?').run(OLD_STAMP, 'm1')
    db.exec(`INSERT INTO note_search_fts (rowid, message_id, conversation_title, note) VALUES (999, 'sentinel', '', 'sentinel')`)

    db.exec(NOTE_SEARCH_SCHEMA_SQL)
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    expect(stampOf('m1')).toBe(OLD_STAMP)
    expect(ids(noteFts())).toEqual(['m1', 'sentinel'])
    expect(ids(topFts())).toEqual(['m1'])
    expect(triggerNames('note_search_docs')).toEqual([...NOTE_SEARCH_TRIGGER_NAMES].sort())
  })

  it('creates the whole search schema from scratch on a fresh database', () => {
    rebuildSearchIndexes(db)
    addMessage('m1', 'conv-1', { note: 'alpha note' })
    expect(noteMatch('alpha')).toEqual(['m1'])
    expect(ids(topFts())).toEqual(['m1'])
    expect(triggerNames('note_search_docs')).toEqual([...NOTE_SEARCH_TRIGGER_NAMES].sort())
    expect(triggerNames('top_level_user_message_search')).toEqual([...TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES].sort())
  })

  it('rebuild replaces legacy triggers, syncs docs without resetting unchanged note stamps, and is idempotent', () => {
    // Legacy state: message_id-keyed FTS rows, stale docs, first-generation trigger names/bodies.
    db.exec(NOTE_SEARCH_TABLES_SQL)
    db.exec(`
      CREATE VIRTUAL TABLE note_search_fts USING fts5(message_id UNINDEXED, conversation_title, note);
      CREATE VIRTUAL TABLE top_level_user_message_search USING fts5(message_id UNINDEXED, content, plain_text_content, note);
      CREATE TRIGGER note_search_docs_fts_insert AFTER INSERT ON note_search_docs BEGIN SELECT 1; END;
      CREATE TRIGGER top_level_user_message_search_update AFTER UPDATE ON messages BEGIN SELECT 1; END;
    `)
    addMessage('kept', 'conv-1', { note: 'kept note' })
    addMessage('changed', 'conv-1', { parentId: 'kept', note: 'new text' })
    addMessage('missing-doc', 'conv-2', { note: 'needs a doc' })
    addMessage('reply', 'conv-2', { parentId: 'missing-doc', role: 'assistant' })
    addMessage('blank', 'conv-2', { parentId: 'reply', note: '' })
    db.exec(`
      INSERT INTO note_search_docs (message_id, conversation_id, user_id, conversation_title, note, note_updated_at) VALUES
        ('kept', 'conv-1', 'user-1', 'Stale title', 'kept note', '${OLD_STAMP}'),
        ('changed', 'conv-1', 'user-1', 'Stale title', 'old text', '${OLD_STAMP}'),
        ('blank', 'conv-2', 'user-1', 'Title two', 'gone', '${OLD_STAMP}');
      INSERT INTO note_search_fts (rowid, message_id, conversation_title, note) VALUES (500, 'kept', 'Stale title', 'kept note');
      INSERT INTO top_level_user_message_search (rowid, message_id, content, plain_text_content, note) VALUES (501, 'kept', 'kept', '', '');
    `)

    rebuildSearchIndexes(db)

    const after = docs()
    expect(ids(after)).toEqual(['changed', 'kept', 'missing-doc'])
    expect(after.find((row: any) => row.message_id === 'kept'))
      .toMatchObject({ conversation_title: 'Title one', note: 'kept note', note_updated_at: OLD_STAMP })
    expect(after.find((row: any) => row.message_id === 'changed')).toMatchObject({ note: 'new text' })
    expect(stampOf('changed')).not.toBe(OLD_STAMP)
    expect(noteFts()).toEqual(after.map((row: any) => ({ rowid: row.rowid, message_id: row.message_id })))
    const topRows = db.prepare(`SELECT rowid, id AS message_id FROM messages WHERE id IN ('kept', 'missing-doc') ORDER BY id`).all()
    expect(topFts()).toEqual(topRows.map((row: any) => ({ rowid: row.rowid, message_id: row.message_id })))
    expect(ids(db.prepare('SELECT message_id FROM note_search_embedding_state ORDER BY message_id').all()))
      .toEqual(['changed', 'kept', 'missing-doc'])
    expect(triggerNames('note_search_docs')).toEqual([...NOTE_SEARCH_TRIGGER_NAMES].sort())
    expect(triggerNames('top_level_user_message_search')).toEqual([...TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES].sort())

    // Triggers are live again.
    addMessage('late', 'conv-2', { note: 'late note' })
    expect(noteMatch('late')).toEqual(['late'])
    expect(ids(topFts())).toEqual(['kept', 'late', 'missing-doc'])

    // A second run changes nothing.
    const before = { docs: docs(), noteFts: noteFts(), topFts: topFts() }
    rebuildSearchIndexes(db)
    expect({ docs: docs(), noteFts: noteFts(), topFts: topFts() }).toEqual(before)
  })

  it('rolls back everything when the rebuild fails part-way', () => {
    db.exec(NOTE_SEARCH_SCHEMA_SQL)
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('m1', 'conv-1', { note: 'alpha note' })
    db.exec(`INSERT INTO top_level_user_message_search (rowid, message_id, content, plain_text_content, note)
      VALUES (999, 'sentinel', 'sentinel', '', '')`)
    const failing = {
      exec: (sql: string) => {
        if (sql.includes('note_search_fts')) throw new Error('boom')
        return db.exec(sql)
      },
    }
    expect(() => rebuildSearchIndexes(failing)).toThrow('boom')
    expect(ids(topFts())).toEqual(['m1', 'sentinel'])
    expect(() => db.exec('BEGIN; COMMIT;')).not.toThrow()
  })
})
