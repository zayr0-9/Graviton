/**
 * Coverage for the messages/tree hot read: GET /api/app/conversations/:id/messages/tree and
 * the gateway's local leg of GET /api/gw/conversations/:id/messages/tree. Both are served by
 * buildConversationMessagesTreePayload. Asserts the payload shape is byte-for-byte what the
 * previous per-message attachment query produced, that every hook run is attached (no 500
 * cap), and that the gateway builds in-process instead of looping back over HTTP.
 */
import type Database from 'better-sqlite3'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAppAutomationRoutes } from '../appAutomationRoutes.js'
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
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, created_at TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, storage_mode TEXT);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT NOT NULL, title TEXT, storage_mode TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, lineage_id TEXT,
      children_ids TEXT DEFAULT '[]', role TEXT NOT NULL, content TEXT NOT NULL, plain_text_content TEXT,
      thinking_block TEXT, tool_calls TEXT, tool_call_id TEXT, model_name TEXT DEFAULT 'unknown',
      note TEXT, note_color TEXT, ex_agent_session_id TEXT, ex_agent_type TEXT, content_blocks TEXT,
      meta TEXT, created_at TEXT
    );
    CREATE TABLE hook_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT, stream_id TEXT, event TEXT NOT NULL, message_id TEXT,
      label TEXT NOT NULL, configured_command TEXT NOT NULL, executed_command TEXT, source_file TEXT NOT NULL,
      scope TEXT NOT NULL, execution_mode TEXT NOT NULL, status TEXT NOT NULL, outcome_code TEXT,
      outcome_summary TEXT, cwd TEXT, started_at TEXT, completed_at TEXT, duration_ms INTEGER,
      error_summary TEXT, stdout_preview TEXT, stderr_preview TEXT, log_path TEXT,
      log_fallback INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE message_attachments (
      id TEXT PRIMARY KEY, message_id TEXT, kind TEXT NOT NULL, mime_type TEXT NOT NULL,
      storage TEXT NOT NULL DEFAULT 'file', url TEXT, file_path TEXT, width INTEGER, height INTEGER,
      size_bytes INTEGER, sha256 TEXT UNIQUE, created_at TEXT, short_id TEXT
    );
    CREATE TABLE message_attachment_links (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, attachment_id TEXT NOT NULL, created_at TEXT,
      UNIQUE(message_id, attachment_id)
    );
  `)
}

function createStatements(db: Database.Database): any {
  return {
    getMessagesByConversationId: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
    getConversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    // The pre-batching per-message query. Kept here as the parity oracle for `attachments`.
    getAttachmentsByMessageId: db.prepare(`
      SELECT ma.*
      FROM message_attachment_links mal
      JOIN message_attachments ma ON ma.id = mal.attachment_id
      WHERE mal.message_id = ?
      ORDER BY ma.created_at ASC
    `),
  }
}

const at = (offsetMs: number) => new Date(1_700_000_000_000 + offsetMs).toISOString()

function seed(db: Database.Database): void {
  db.prepare(`INSERT INTO users (id, username, created_at) VALUES ('u1', 'u1', ?)`).run(at(0))
  const insConv = db.prepare(`INSERT INTO conversations (id, user_id, title, storage_mode, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, ?)`)
  insConv.run('c1', 'local conv', 'local', at(0), at(0))
  insConv.run('c2', 'other conv', 'local', at(0), at(0))
  insConv.run('c-empty', 'empty conv', 'local', at(0), at(0))

  const insMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, content_blocks, tool_calls, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insMsg.run('m1', 'c1', null, '["m2"]', 'user', 'hello', JSON.stringify([{ type: 'text', index: 0, content: 'hello' }]), null, at(1000))
  insMsg.run('m2', 'c1', 'm1', '["m3"]', 'assistant', 'hi', JSON.stringify([{ type: 'tool_use', index: 0, id: 't1', name: 'read_file', input: {} }]), JSON.stringify([{ id: 't1', name: 'read_file', arguments: '{}', status: 'complete' }]), at(2000))
  insMsg.run('m3', 'c1', 'm2', '[]', 'user', 'thanks', null, null, at(3000))
  // Another conversation with its own attachment and hook run: must never leak into c1.
  insMsg.run('x1', 'c2', null, '[]', 'user', 'elsewhere', null, null, at(1000))

  const insAtt = db.prepare(`INSERT INTO message_attachments (id, kind, mime_type, storage, file_path, width, height, size_bytes, sha256, created_at, short_id) VALUES (?, 'image', 'image/png', 'file', ?, 10, 10, 100, ?, ?, ?)`)
  const insLink = db.prepare(`INSERT INTO message_attachment_links (id, message_id, attachment_id, created_at) VALUES (?, ?, ?, ?)`)
  // Insert the newer attachment first so result order proves ORDER BY created_at, not insertion order.
  insAtt.run('att-b', '/tmp/b.png', 'sha-b', at(200), 'sb')
  insAtt.run('att-a', '/tmp/a.png', 'sha-a', at(100), 'sa')
  insAtt.run('att-x', '/tmp/x.png', 'sha-x', at(100), 'sx')
  insLink.run('l1', 'm1', 'att-b', at(0))
  insLink.run('l2', 'm1', 'att-a', at(0))
  insLink.run('l3', 'm3', 'att-a', at(0)) // same attachment linked to a second message
  insLink.run('l4', 'x1', 'att-x', at(0))

  const insRun = db.prepare(`
    INSERT INTO hook_runs (id, conversation_id, event, message_id, label, configured_command, source_file, scope, execution_mode, status, stdout_preview, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'lbl', 'echo hi', 'hooks.json', 'project', 'sync', 'succeeded', 'out', ?, ?)
  `)
  db.transaction(() => {
    // 505 older runs on m1: more than the previous newest-first LIMIT 500 could carry.
    for (let i = 0; i < 505; i++) insRun.run(`r-m1-${String(i).padStart(3, '0')}`, 'c1', 'PostToolUse', 'm1', at(10_000 + i), at(10_000 + i))
    // 5 newer runs on m3.
    for (let i = 0; i < 5; i++) insRun.run(`r-m3-${i}`, 'c1', 'Stop', 'm3', at(20_000 + i), at(20_000 + i))
    // A run with no message, and a run in another conversation: both excluded.
    insRun.run('r-orphan', 'c1', 'SessionStart', null, at(30_000), at(30_000))
    insRun.run('r-other', 'c2', 'Stop', 'x1', at(30_000), at(30_000))
  })()
}

describeIfSqlite('messages/tree read', () => {
  let db: Database.Database
  let statements: any
  let server: Server
  let baseUrl: string
  let fetchImpl: ReturnType<typeof vi.fn>
  let railway: { passthrough: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    db = new BetterSqlite3Ctor!(':memory:')
    createSchema(db)
    seed(db)
    statements = createStatements(db)
    fetchImpl = vi.fn(async () => { throw new Error('loopback fetch must not be used for the local tree') })
    railway = { passthrough: vi.fn(async () => ({ ok: false, status: 404, body: { error: 'cloud: not found' } })) }
    const app = express()
    app.use(express.json())
    registerAppAutomationRoutes(app, { db, statements })
    registerGatewayRoutes(app, {
      railway: railway as any,
      mirror: { mirror: vi.fn(async () => {}) } as any,
      auth: { getFreshAppToken: vi.fn(async () => ({ accessToken: 'tok' })) } as any,
      db,
      statements,
      enabled: true,
      fetchImpl: fetchImpl as any,
    })
    server = app.listen(0)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(() => {
    server.close()
    db.close()
  })

  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`)
    return { status: res.status, body: await res.json() }
  }

  it('attaches the same attachment rows, in the same order, as the per-message query did', async () => {
    const { status, body } = await get('/api/app/conversations/c1/messages/tree')
    expect(status).toBe(200)
    expect(body.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3'])

    for (const message of body.messages) {
      expect(message.attachments).toEqual(statements.getAttachmentsByMessageId.all(message.id))
      expect(message.attachments_count).toBe(message.attachments.length)
      expect(message.has_attachments).toBe(message.attachments.length > 0)
    }
    const [m1, m2, m3] = body.messages
    expect(m1.attachments.map((a: any) => a.id)).toEqual(['att-a', 'att-b'])
    expect(m2.attachments).toEqual([])
    expect(m2.has_attachments).toBe(false)
    expect(m3.attachments.map((a: any) => a.id)).toEqual(['att-a'])
    // The grouping key must not leak into the attachment objects.
    expect(Object.keys(m1.attachments[0])).not.toContain('link_message_id')
  })

  it('parses JSON columns and builds the tree and meta as before', async () => {
    const { body } = await get('/api/app/conversations/c1/messages/tree')
    const [m1, m2, m3] = body.messages
    expect(m1.children_ids).toEqual(['m2'])
    expect(m1.content_blocks).toEqual([{ type: 'text', index: 0, content: 'hello' }])
    expect(m1.tool_calls).toBeNull()
    expect(m2.tool_calls).toEqual([{ id: 't1', name: 'read_file', arguments: '{}', status: 'complete' }])
    expect(m3.content_blocks).toBeNull()
    expect(m3.children_ids).toEqual([])

    expect(body.tree).toEqual({
      id: 'm1', message: 'hello', sender: 'user', children: [
        { id: 'm2', message: 'hi', sender: 'assistant', children: [
          { id: 'm3', message: 'thanks', sender: 'user', children: [] },
        ] },
      ],
    })
    expect(body.meta).toEqual({ storage_mode: 'local' })
  })

  it('attaches every hook run per message, newest first, with no 500-row cap', async () => {
    const { body } = await get('/api/app/conversations/c1/messages/tree')
    const [m1, m2, m3] = body.messages
    expect(m1.hook_runs).toHaveLength(505)
    expect(m2.hook_runs).toEqual([])
    expect(m3.hook_runs).toHaveLength(5)
    expect(m3.hook_runs[0].id).toBe('r-m3-4')
    expect(m1.hook_runs[0].id).toBe('r-m1-504')
    expect(m1.hook_runs.at(-1).id).toBe('r-m1-000')
    // Records are the redacted HookRunRecord shape, keyed camelCase.
    expect(m3.hook_runs[0]).toMatchObject({ messageId: 'm3', event: 'Stop', configuredCommand: 'echo hi', status: 'succeeded' })
    const allIds = body.messages.flatMap((m: any) => m.hook_runs.map((r: any) => r.id))
    expect(allIds).not.toContain('r-orphan')
    expect(allIds).not.toContain('r-other')
  })

  it('returns an empty tree for a conversation with no messages', async () => {
    const app = await get('/api/app/conversations/c-empty/messages/tree')
    const gw = await get('/api/gw/conversations/c-empty/messages/tree')
    expect(app.status).toBe(200)
    expect(app.body).toEqual({ messages: [], tree: null, meta: { storage_mode: 'local' } })
    expect(gw.body).toEqual(app.body)
  })

  it('gateway serves a local conversation in-process and identically to the app route', async () => {
    const app = await get('/api/app/conversations/c1/messages/tree')
    const gw = await get('/api/gw/conversations/c1/messages/tree')
    expect(gw.status).toBe(200)
    expect(gw.body).toEqual(app.body)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(railway.passthrough).not.toHaveBeenCalled()
  })

  it('gateway still routes an unknown conversation to the cloud leg', async () => {
    const gw = await get('/api/gw/conversations/not-local/messages/tree')
    expect(gw.status).toBe(404)
    expect(gw.body).toEqual({ error: 'cloud: not found' })
    expect(railway.passthrough).toHaveBeenCalledTimes(1)
    expect(railway.passthrough.mock.calls[0][0]).toMatchObject({ method: 'GET', path: '/conversations/not-local/messages/tree' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
