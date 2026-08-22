/**
 * Integration coverage for the storage-aware attachment routes on /api/gw/*.
 * Boots the real gateway against an in-memory better-sqlite3 + a mock Railway
 * client/mirror, and asserts the local-vs-cloud routing (by the message's parent
 * conversation storage_mode + the ?storageMode= override), the delete leg, and
 * the multipart upload passthrough (raw body forwarded to Railway, then mirrored
 * + linked locally).
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
  let railway: { passthrough: ReturnType<typeof vi.fn> }
  let mirror: { mirror: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    const database = new BetterSqlite3Ctor!(':memory:')
    db = database
    createSchema(database)
    const statements = createStatements(database)

    // Seed: a local conversation + message with one linked attachment; a cloud conversation + message.
    database.prepare('INSERT INTO conversations (id, storage_mode) VALUES (?, ?)').run('c-local', 'local')
    database.prepare('INSERT INTO conversations (id, storage_mode) VALUES (?, ?)').run('c-cloud', 'cloud')
    database.prepare('INSERT INTO messages (id, conversation_id) VALUES (?, ?)').run('m-local', 'c-local')
    database.prepare('INSERT INTO messages (id, conversation_id) VALUES (?, ?)').run('m-cloud', 'c-cloud')
    statements.insertAttachment.run('att-local', 'm-local', 'image', 'image/png', 'local', null, '2024-01-01T00:00:00Z')
    statements.linkAttachment.run('m-local:att-local', 'm-local', 'att-local', '2024-01-01T00:00:00Z')

    railway = { passthrough: vi.fn(async () => ({ ok: true, status: 200, body: [{ id: 'att-cloud' }], contentType: 'application/json' })) }
    mirror = { mirror: vi.fn(async () => {}) }
    const auth = { getFreshAppToken: vi.fn(async () => ({ userId: 'u1', accessToken: 'tok' })) }

    const app = express()
    app.use(express.json())
    registerGatewayRoutes(app, {
      railway: railway as any,
      mirror: mirror as any,
      auth: auth as any,
      db: database,
      statements,
      enabled: true,
    })
    server = app.listen(0)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (db) db.close()
    vi.restoreAllMocks()
  })

  it('GET messages/:id/attachments reads local SQLite for a local-conversation message (no Railway)', async () => {
    const res = await fetch(`${baseUrl}/api/gw/messages/m-local/attachments`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as any[]
    expect(body.map(a => a.id)).toEqual(['att-local'])
    expect(railway.passthrough).not.toHaveBeenCalled()
  })

  it('GET messages/:id/attachments routes to Railway for a cloud-conversation message', async () => {
    const res = await fetch(`${baseUrl}/api/gw/messages/m-cloud/attachments`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 'att-cloud' }])
    expect(railway.passthrough).toHaveBeenCalledTimes(1)
    expect(railway.passthrough.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/messages/m-cloud/attachments' })
  })

  it('honors the ?storageMode=cloud override even for a local-conversation message', async () => {
    await fetch(`${baseUrl}/api/gw/messages/m-local/attachments?storageMode=cloud`)
    expect(railway.passthrough).toHaveBeenCalledTimes(1)
    expect(railway.passthrough.mock.calls[0][0]).toMatchObject({ path: '/messages/m-local/attachments' })
  })

  it('DELETE messages/:id/attachments removes local links and reports the count', async () => {
    const res = await fetch(`${baseUrl}/api/gw/messages/m-local/attachments`, { method: 'DELETE' })
    expect(await res.json()).toEqual({ deleted: 1 })
    // Link is gone; a follow-up read returns empty.
    const after = await (await fetch(`${baseUrl}/api/gw/messages/m-local/attachments`)).json()
    expect(after).toEqual([])
    expect(railway.passthrough).not.toHaveBeenCalled()
  })

  it('GET attachments/:id returns the local row when present, else Railway', async () => {
    const local = await (await fetch(`${baseUrl}/api/gw/attachments/att-local`)).json()
    expect(local).toMatchObject({ id: 'att-local' })
    expect(railway.passthrough).not.toHaveBeenCalled()

    railway.passthrough.mockResolvedValueOnce({ ok: true, status: 200, body: { id: 'att-remote' }, contentType: 'application/json' })
    const remote = await (await fetch(`${baseUrl}/api/gw/attachments/att-remote`)).json()
    expect(remote).toEqual({ id: 'att-remote' })
    expect(railway.passthrough).toHaveBeenCalledTimes(1)
  })

  it('POST attachments forwards the raw multipart body to Railway and mirrors + links the result', async () => {
    railway.passthrough.mockResolvedValueOnce({
      ok: true,
      status: 201,
      body: { id: 'att-uploaded', message_id: 'm-cloud', kind: 'image', mime_type: 'image/png' },
      contentType: 'application/json',
    })
    const res = await fetch(`${baseUrl}/api/gw/attachments?messageId=m-cloud`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      body: '--xyz\r\nContent-Disposition: form-data; name="file"\r\n\r\nbytes\r\n--xyz--',
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ id: 'att-uploaded' })

    const call = railway.passthrough.mock.calls[0][0]
    expect(call).toMatchObject({ method: 'POST', path: '/attachments' })
    expect(call.headers['Content-Type']).toBe('multipart/form-data; boundary=xyz')
    expect(Buffer.isBuffer(call.body)).toBe(true)

    expect(mirror.mirror).toHaveBeenCalledWith('attachment', expect.objectContaining({ id: 'att-uploaded', message_id: 'm-cloud' }))
    // A local link row now associates the uploaded attachment with the message.
    const linked = db!.prepare('SELECT * FROM message_attachment_links WHERE message_id = ? AND attachment_id = ?').get('m-cloud', 'att-uploaded')
    expect(linked).toBeTruthy()
  })
})
