/**
 * Integration coverage for the local attachment routes on /api/gw/*. Boots the real
 * gateway against an in-memory better-sqlite3 and asserts reads, links, deletes and
 * that no hosted backend is involved (legacy ?storageMode= hints are ignored).
 */
import type Database from 'better-sqlite3'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerGatewayRoutes } from '../gatewayRoutes.js'

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
    CREATE TABLE conversations (id TEXT PRIMARY KEY, storage_mode TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, storage_mode TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE message_attachments (
      id TEXT PRIMARY KEY, message_id TEXT, kind TEXT, mime_type TEXT, storage TEXT,
      url TEXT, file_path TEXT, width INTEGER, height INTEGER, size_bytes INTEGER,
      sha256 TEXT, created_at TEXT, short_id TEXT
    );
    CREATE TABLE message_attachment_links (id TEXT PRIMARY KEY, message_id TEXT, attachment_id TEXT, created_at TEXT);
  `)
}

function createStatements(db: Database.Database): any {
  return {
    getAttachmentsByMessageId: db.prepare(`
      SELECT ma.* FROM message_attachment_links mal
      JOIN message_attachments ma ON ma.id = mal.attachment_id
      WHERE mal.message_id = ? ORDER BY ma.created_at ASC
    `),
    getAttachmentById: db.prepare('SELECT * FROM message_attachments WHERE id = ?'),
    linkAttachment: db.prepare(
      'INSERT OR IGNORE INTO message_attachment_links (id, message_id, attachment_id, created_at) VALUES (?, ?, ?, ?)'
    ),
    insertAttachment: db.prepare(
      'INSERT INTO message_attachments (id, message_id, kind, mime_type, storage, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
  }
}

describeIfSqlite('gateway attachment routes', () => {
  let db: Database.Database | undefined
  let server: Server | undefined
  let baseUrl = ''
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    const database = new BetterSqlite3Ctor!(':memory:')
    db = database
    createSchema(database)
    const statements = createStatements(database)

    // Seed: a local conversation + message with one linked attachment, and a legacy cloud-mode row.
    database.prepare('INSERT INTO conversations (id, storage_mode) VALUES (?, ?)').run('c-local', 'local')
    database.prepare('INSERT INTO conversations (id, storage_mode) VALUES (?, ?)').run('c-cloud', 'cloud')
    database.prepare('INSERT INTO messages (id, conversation_id) VALUES (?, ?)').run('m-local', 'c-local')
    database.prepare('INSERT INTO messages (id, conversation_id) VALUES (?, ?)').run('m-cloud', 'c-cloud')
    statements.insertAttachment.run('att-local', 'm-local', 'image', 'image/png', 'local', null, '2024-01-01T00:00:00Z')
    statements.linkAttachment.run('m-local:att-local', 'm-local', 'att-local', '2024-01-01T00:00:00Z')

    const app = express()
    app.use(express.json())
    registerGatewayRoutes(app, { db: database, statements })
    server = app.listen(0)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (db) db.close()
    vi.restoreAllMocks()
  })

  const outboundOtherThanTest = () => fetchSpy.mock.calls.map(call => String(call[0])).filter(url => !url.startsWith(baseUrl))

  it('GET messages/:id/attachments reads local SQLite', async () => {
    const res = await fetch(`${baseUrl}/api/gw/messages/m-local/attachments`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any[]
    expect(body.map(a => a.id)).toEqual(['att-local'])
    expect(outboundOtherThanTest()).toEqual([])
  })

  it('serves legacy cloud-mode rows and ?storageMode=cloud hints from local SQLite too', async () => {
    expect(await (await fetch(`${baseUrl}/api/gw/messages/m-cloud/attachments`)).json()).toEqual([])
    const hinted = (await (await fetch(`${baseUrl}/api/gw/messages/m-local/attachments?storageMode=cloud`)).json()) as any[]
    expect(hinted.map(a => a.id)).toEqual(['att-local'])
    expect(outboundOtherThanTest()).toEqual([])
  })

  it('DELETE messages/:id/attachments removes local links and reports the count', async () => {
    const res = await fetch(`${baseUrl}/api/gw/messages/m-local/attachments`, { method: 'DELETE' })
    expect(await res.json()).toEqual({ deleted: 1 })
    // Link is gone; a follow-up read returns empty.
    const after = await (await fetch(`${baseUrl}/api/gw/messages/m-local/attachments`)).json()
    expect(after).toEqual([])
    expect(outboundOtherThanTest()).toEqual([])
  })

  it('GET attachments/:id returns the local row, or 404 when it does not exist', async () => {
    const local = await (await fetch(`${baseUrl}/api/gw/attachments/att-local`)).json()
    expect(local).toMatchObject({ id: 'att-local' })
    const missing = await fetch(`${baseUrl}/api/gw/attachments/att-remote`)
    expect(missing.status).toBe(404)
    expect(outboundOtherThanTest()).toEqual([])
  })

  it('has no multipart upload route (uploads were Railway-only)', async () => {
    const res = await fetch(`${baseUrl}/api/gw/attachments?messageId=m-local`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(404)
  })
})
