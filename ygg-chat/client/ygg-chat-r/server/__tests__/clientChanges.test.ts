import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { installMessageRevisions } from '../messageRevisionSchema.js'
import { installClientChangeSchema } from '../clientChangeSchema.js'

describe('transactional client change outbox', () => {
  it('covers background/direct writers, committed revisions, deletes and rollback', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT, content TEXT);
        CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT);`)
      installMessageRevisions(db); installClientChangeSchema(db)
      db.exec("INSERT INTO messages VALUES ('m','c','first',0)")
      db.exec("UPDATE messages SET content='second' WHERE id='m'")
      const rows = () => db.prepare('SELECT domain,entity_id,revision,deleted FROM client_changes ORDER BY seq').all()
      expect(rows()).toEqual([
        { domain: 'messages', entity_id: 'm', revision: 0, deleted: 0 },
        { domain: 'messages', entity_id: 'm', revision: 1, deleted: 0 },
      ])
      db.exec("UPDATE messages SET content='second' WHERE id='m'")
      expect(rows()).toHaveLength(2)
      expect(() => db.transaction(() => { db.exec("UPDATE messages SET content='rollback'"); throw new Error('rollback') })()).toThrow()
      expect(rows()).toHaveLength(2)
      db.exec("DELETE FROM messages WHERE id='m'")
      expect(rows().at(-1)).toMatchObject({ entity_id: 'm', deleted: 1 })
      db.exec("INSERT INTO projects VALUES ('p','one'); UPDATE projects SET name='two'; INSERT INTO conversations VALUES ('c','chat')")
      expect(rows().slice(-3).map((row: any) => row.domain)).toEqual(['projects', 'projects', 'conversations'])
    } finally { db.close() }
  })
})
