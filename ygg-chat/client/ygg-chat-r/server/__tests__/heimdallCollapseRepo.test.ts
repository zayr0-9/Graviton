import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEIMDALL_COLLAPSE_SCHEMA,
  HeimdallCollapseRepo,
  HeimdallCollapseValidationError,
  parseHeimdallCollapseGroups,
} from '../headlessServer/persistence/heimdallCollapseRepo.js'
import { registerHeimdallCollapseRoutes } from '../routes/heimdallCollapseRoutes.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE);
  `)
  db.exec(HEIMDALL_COLLAPSE_SCHEMA)
  db.exec(HEIMDALL_COLLAPSE_SCHEMA) // Fresh CREATE and the v13 migration converge.
  db.exec("INSERT INTO conversations VALUES ('c1'), ('c2')")
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?)')
  for (const id of ['a', 'b', 'c', 'd']) insert.run(id, 'c1')
  insert.run('other', 'c2')
})

afterEach(() => db.close())

describe('HeimdallCollapseRepo', () => {
  it('replaces and lists groups in order', () => {
    const repo = new HeimdallCollapseRepo(db)
    repo.replace('c1', [{ id: 'g2', memberIds: ['c', 'd'] }, { id: 'g1', memberIds: ['a', 'b'] }])
    expect(repo.list('c1')).toEqual([{ id: 'g2', memberIds: ['c', 'd'] }, { id: 'g1', memberIds: ['a', 'b'] }])

    repo.replace('c1', [{ id: 'g1', memberIds: ['a', 'b', 'c'] }])
    expect(repo.list('c1')).toEqual([{ id: 'g1', memberIds: ['a', 'b', 'c'] }])
    expect(repo.list('c2')).toEqual([])
  })

  it('drops ids from other conversations, deleted messages and groups left with one member', () => {
    const repo = new HeimdallCollapseRepo(db)
    expect(repo.replace('c1', [
      { id: 'g1', memberIds: ['a', 'b', 'other', 'missing'] },
      { id: 'g2', memberIds: ['c', 'other'] },
    ])).toEqual([{ id: 'g1', memberIds: ['a', 'b'] }])

    db.prepare("DELETE FROM messages WHERE id = 'b'").run()
    expect(repo.list('c1')).toEqual([])
  })

  it('cascades with the conversation', () => {
    const repo = new HeimdallCollapseRepo(db)
    repo.replace('c1', [{ id: 'g1', memberIds: ['a', 'b'] }])
    db.prepare("DELETE FROM conversations WHERE id = 'c1'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM heimdall_collapse_groups').get()).toEqual({ n: 0 })
  })

  it('validates untrusted bodies', () => {
    expect(() => parseHeimdallCollapseGroups(null)).toThrow(HeimdallCollapseValidationError)
    expect(() => parseHeimdallCollapseGroups([{ id: '', memberIds: [] }])).toThrow(HeimdallCollapseValidationError)
    expect(() => parseHeimdallCollapseGroups([{ id: 'g', memberIds: [1] }])).toThrow(HeimdallCollapseValidationError)
    expect(() => parseHeimdallCollapseGroups([{ id: 'g', memberIds: [] }, { id: 'g', memberIds: [] }])).toThrow('duplicate')
    expect(parseHeimdallCollapseGroups([{ id: 'g', memberIds: ['a', 'a', 'b'] }])).toEqual([{ id: 'g', memberIds: ['a', 'b'] }])
  })
})

describe('heimdall collapse routes', () => {
  const setup = () => {
    const handlers = new Map<string, any>()
    const app = Object.fromEntries(['get', 'put'].map(method => [method, (_path: string, handler: any) => handlers.set(method, handler)]))
    registerHeimdallCollapseRoutes(app as any, { db })
    const res = () => {
      const response = { json: vi.fn(), status: vi.fn() }
      response.status.mockReturnValue(response)
      return response
    }
    return { handlers, res }
  }

  it('round-trips a PUT through GET', () => {
    const { handlers, res } = setup()
    const put = res()
    handlers.get('put')({ params: { id: 'c1' }, body: { groups: [{ id: 'g', memberIds: ['a', 'b'] }] } }, put)
    expect(put.json).toHaveBeenCalledWith({ groups: [{ id: 'g', memberIds: ['a', 'b'] }] })

    const get = res()
    handlers.get('get')({ params: { id: 'c1' } }, get)
    expect(get.json).toHaveBeenCalledWith({ groups: [{ id: 'g', memberIds: ['a', 'b'] }] })
  })

  it('rejects bad bodies with 400 and unknown conversations with 404', () => {
    const { handlers, res } = setup()
    const bad = res()
    handlers.get('put')({ params: { id: 'c1' }, body: { groups: 'nope' } }, bad)
    expect(bad.status).toHaveBeenCalledWith(400)

    const missing = res()
    handlers.get('get')({ params: { id: 'nope' } }, missing)
    expect(missing.status).toHaveBeenCalledWith(404)
  })
})
