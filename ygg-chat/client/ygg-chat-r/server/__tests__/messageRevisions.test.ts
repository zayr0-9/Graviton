import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { installMessageRevisions } from '../messageRevisionSchema.js'
import { reconcileHeadlessRuns } from '../headlessServer/persistence/reconcileHeadlessRuns.js'

const source = readFileSync(new URL('../localServer.ts', import.meta.url), 'utf8')
const schema = (table: string) => source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n    \\)`))![0]

describe('host message revisions', () => {
  for (const recursive of [false, true]) for (const legacy of [false, true]) {
    it(`covers every actual column update, no-ops, upserts and rollback (recursive=${recursive}, legacy=${legacy})`, () => {
      const db = new Database(':memory:')
    db.pragma('foreign_keys = OFF') // Isolate message triggers from unrelated fixture tables.
      try {
        db.pragma(`recursive_triggers = ${recursive ? 'ON' : 'OFF'}`)
        db.exec(legacy ? schema('messages').replace('revision INTEGER NOT NULL DEFAULT 0,', '') : schema('messages'))
        installMessageRevisions(db); installMessageRevisions(db)
        db.prepare("INSERT INTO messages(id, conversation_id, role, content) VALUES ('m', 'c', 'assistant', '')").run()
        const revision = () => (db.prepare("SELECT revision FROM messages WHERE id='m'").get() as any).revision
        expect(revision()).toBe(0)
        const columns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
        let expected = 0
        for (const { name } of columns) {
          if (['id', 'revision'].includes(name)) continue
          const value = name === 'role' ? 'user' : `changed-${name}`
          db.prepare(`UPDATE messages SET "${name}" = ? WHERE id='m'`).run(value)
          expect(revision()).toBe(++expected)
          db.prepare(`UPDATE messages SET "${name}" = ? WHERE id='m'`).run(value)
          expect(revision()).toBe(expected)
        }
        db.prepare("INSERT INTO messages(id, conversation_id, role, content) VALUES ('m','c','assistant','adopted') ON CONFLICT(id) DO UPDATE SET content=excluded.content").run()
        expect(revision()).toBe(++expected)
        expect(() => db.transaction(() => { db.exec("UPDATE messages SET note='rollback' WHERE id='m'"); throw new Error('rollback') })()).toThrow('rollback')
        expect(revision()).toBe(expected)
      } finally { db.close() }
    })
  }
  it('increments a parent once for an insert trigger and repairs', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = OFF') // Isolate message triggers from unrelated fixture tables.
    try {
      db.exec(schema('messages')); installMessageRevisions(db)
      db.exec(`CREATE TRIGGER children AFTER INSERT ON messages WHEN NEW.parent_id IS NOT NULL
        BEGIN UPDATE messages SET children_ids=json_insert(children_ids, '$[#]', NEW.id) WHERE id=NEW.parent_id; END;
        INSERT INTO messages(id,conversation_id,role,content) VALUES ('p','c','user','');
        INSERT INTO messages(id,conversation_id,parent_id,role,content) VALUES ('child','c','p','assistant','');`)
      const read = () => db.prepare("SELECT revision, children_ids FROM messages WHERE id='p'").get() as any
      expect(read()).toEqual({ revision: 1, children_ids: '["child"]' })
      db.exec("DELETE FROM messages WHERE id='child'; UPDATE messages SET children_ids='[]' WHERE id='p'")
      expect(read().revision).toBe(2)
    } finally { db.close() }
  })
})

describe('headless host restart', () => {
  it('only interrupts running headless rows and preserves metadata, with valid SQL statuses', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = OFF') // Isolate message triggers from unrelated fixture tables.
    try {
      db.exec(schema('streaming_runs'))
      const insert = db.prepare('INSERT INTO streaming_runs(stream_id, source, status, started_at, metadata_json) VALUES (?,?,?,?,?)')
      for (const owner of ['headless', 'renderer', 'tool', 'subagent', 'unknown']) insert.run(owner, owner, 'running', '2026-01-01T00:00:00Z', '{"kept":true}')
      insert.run('done', 'headless', 'completed', '2026-01-01T00:00:00Z', '{}')
      expect(reconcileHeadlessRuns(db, 'epoch', '2026-01-01T00:00:01Z')).toBe(1)
      const row = db.prepare("SELECT * FROM streaming_runs WHERE stream_id='headless'").get() as any
      expect(row).toMatchObject({ status: 'aborted', end_reason: 'unknown', duration_ms: 1000 })
      expect(JSON.parse(row.metadata_json)).toEqual({ kept: true, interrupted: { epoch: 'epoch', reason: 'host_restart' } })
      expect(reconcileHeadlessRuns(db, 'other')).toBe(0)
      expect(db.prepare("SELECT count(*) AS n FROM streaming_runs WHERE status='running'").get()).toEqual({ n: 4 })
    } finally { db.close() }
  })
})
