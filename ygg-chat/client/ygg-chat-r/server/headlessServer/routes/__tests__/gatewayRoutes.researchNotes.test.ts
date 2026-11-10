/** The research-notes list is read from local SQLite (it used to come from the hosted account API). */
import type Database from 'better-sqlite3'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerGatewayRoutes } from '../gatewayRoutes.js'

let BetterSqlite3Ctor: (new (filename: string) => Database.Database) | null = null
try {
  const sqliteModule = await import('better-sqlite3')
  const candidate = sqliteModule.default as new (filename: string) => Database.Database
  new candidate(':memory:').close()
  BetterSqlite3Ctor = candidate
} catch {
  BetterSqlite3Ctor = null
}
const describeIfSqlite = BetterSqlite3Ctor ? describe : describe.skip

describeIfSqlite('GET /api/gw/research-notes', () => {
  let db: Database.Database
  let server: Server
  let baseUrl = ''

  beforeEach(() => {
    db = new BetterSqlite3Ctor!(':memory:')
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT, project_id TEXT, title TEXT,
        research_note TEXT, storage_mode TEXT, updated_at TEXT);
      INSERT INTO conversations VALUES ('old', 'u', 'p', 'Old', 'first note', 'local', '2026-01-01');
      INSERT INTO conversations VALUES ('new', 'u', NULL, 'New', 'second note', 'local', '2026-02-01');
      INSERT INTO conversations VALUES ('blank', 'u', NULL, 'Blank', '   ', 'local', '2026-03-01');
      INSERT INTO conversations VALUES ('none', 'u', NULL, 'None', NULL, 'local', '2026-03-01');
      INSERT INTO conversations VALUES ('mirror', 'u', NULL, 'Mirror', 'legacy cloud mirror', 'cloud', '2026-03-01');
      INSERT INTO conversations VALUES ('other', 'someone-else', NULL, 'Other', 'not mine', 'local', '2026-03-01');
    `)
    const app = express()
    app.use(express.json())
    registerGatewayRoutes(app, { db, statements: {} })
    server = app.listen(0)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  })

  it("lists the user's non-empty local notes, newest first", async () => {
    const response = await fetch(`${baseUrl}/api/gw/research-notes?userId=u`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { id: 'new', title: 'New', research_note: 'second note', updated_at: '2026-02-01', project_id: null },
      { id: 'old', title: 'Old', research_note: 'first note', updated_at: '2026-01-01', project_id: 'p' },
    ])
  })
})
