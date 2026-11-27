/**
 * Coverage for the messages/tree hot read: GET /api/app/conversations/:id/messages/tree and
 * the gateway's local leg of GET /api/gw/conversations/:id/messages/tree. Both are served by
 * buildConversationMessagesTreePayload. Asserts the payload shape is byte-for-byte what the
 * previous per-message attachment query produced, that every hook run is attached (no 500
 * cap), and that the gateway builds in-process instead of looping back over HTTP.
 */
import type Database from 'better-sqlite3'
import express from 'express'
import { request, type Server } from 'node:http'
import { gunzipSync } from 'node:zlib'
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

// Node's fetch adds `Cache-Control: no-cache` to any request given If-None-Match by hand, which
// rightly disables freshness. Browsers revalidate from their cache without it; mimic that raw.
const conditional = (url: string, etag: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request(url, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etag } }, res => {
    const chunks: Buffer[] = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => {
      const raw = Buffer.concat(chunks)
      resolve({ status: res.statusCode ?? 0, body: (raw.length > 0 && res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8') })
    })
  })
  req.on('error', reject)
  req.end()
})

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
      meta TEXT, created_at TEXT, revision INTEGER NOT NULL DEFAULT 1
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

  beforeEach(() => {
    db = new BetterSqlite3Ctor!(':memory:')
    createSchema(db)
    seed(db)
    statements = createStatements(db)
    fetchImpl = vi.fn(async () => { throw new Error('loopback fetch must not be used for the local tree') })
    const app = express()
    app.use(express.json())
    registerAppAutomationRoutes(app, { db, statements })
    registerGatewayRoutes(app, { db, statements, fetchImpl: fetchImpl as any })
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

  it('discloses only the requested ancestry and its enrichment, even with a multi-megabyte sibling', async () => {
    db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at)
      VALUES ('fork', 'c1', 'm1', 'assistant', ?, ?)`).run('z'.repeat(4 * 1024 * 1024), at(9000))
    const { body } = await get('/api/app/conversations/c1/messages/tree?scope=branch&tip=m2')
    expect(body.messages.map((row: any) => row.id)).toEqual(['m1', 'm2', 'm3'])
    expect(body.messages[0].attachments).toHaveLength(2)
    expect(body.messages[0].hook_runs).toHaveLength(505)
    expect(body.retained).toEqual([['fork', 1]])
    expect(body.tree).toBeNull()
    expect(JSON.stringify(body).length).toBeLessThan(512 * 1024)
    const { body: fallback } = await get('/api/app/conversations/c1/messages/tree?scope=branch&tip=x1')
    expect(fallback.messages.map((row: any) => row.id)).toEqual(['m1', 'fork'])
    expect((await get('/api/app/conversations/c-empty/messages/tree?scope=branch')).body).toEqual({ retained: [], messages: [], tree: null })
  })

  type TreeBlock = { type: string; omitted?: boolean; content?: string }
  type TreeRow = { id: string; body_omitted?: boolean; body_omitted_chars?: number; content: string; content_blocks: TreeBlock[]; attachments: Array<{ id: string }>; hook_runs: unknown[] }
  it('compacts large block payloads outside the window, hydrates them on demand and answers 304 when unchanged', async () => {
    const blocks = JSON.stringify([
      { type: 'text', index: 0, content: 'kept prose' },
      { type: 'thinking', index: 1, content: 't'.repeat(500) },
      { type: 'tool_use', index: 2, id: 't9', name: 'read_file', input: { path: '/tmp/x', data: 'y'.repeat(5000) } },
      { type: 'tool_result', index: 3, tool_use_id: 't9', content: 'z'.repeat(20000), is_error: false },
      { type: 'context_usage', index: 4, usage: { usedTokens: 1 } },
    ])
    const insert = db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, content_blocks, created_at) VALUES (?, ?, ?, '[]', ?, ?, ?, ?)`)
    insert.run('big', 'c1', 'm3', 'assistant', '', blocks, at(4000))
    insert.run('tail', 'c1', 'big', 'user', 'latest', null, at(5000))

    const { body } = await get('/api/app/conversations/c1/messages/tree?scope=branch&tip=tail&window=1')
    expect(body.messages.map((row: TreeRow) => [row.id, row.body_omitted ?? false])).toEqual([['m1', false], ['m2', false], ['m3', false], ['big', true], ['tail', false]])
    const big = body.messages[3]
    expect(big.body_omitted_chars).toBeGreaterThan(25000)
    expect(big.content_blocks.map((block: TreeBlock) => [block.type, block.omitted ?? false])).toEqual([
      ['text', false], ['thinking', true], ['tool_use', true], ['tool_result', true], ['context_usage', false],
    ])
    expect(big.content_blocks[0].content).toBe('kept prose')
    expect(big.content_blocks[1].content).toBe('t'.repeat(160))
    expect(big.content_blocks[2]).toEqual({ type: 'tool_use', index: 2, id: 't9', name: 'read_file', input: { path: '/tmp/x' }, omitted: true })
    expect(big.content_blocks[3]).toEqual({ type: 'tool_result', index: 3, tool_use_id: 't9', is_error: false, omitted: true })
    expect(JSON.stringify(big).length).toBeLessThan(2048)
    // Small rows outside the window are not flagged: nothing was dropped from them.
    expect(body.messages[1].content_blocks).toEqual(JSON.parse(statements.getMessagesByConversationId.all('c1')[1].content_blocks))

    const wide = await get('/api/app/conversations/c1/messages/tree?scope=branch&tip=tail&window=10')
    expect(wide.body.messages.some((row: TreeRow) => row.body_omitted)).toBe(false)
    const full = await get('/api/app/conversations/c1/messages/tree?scope=branch&tip=tail')
    expect(full.body.messages.some((row: TreeRow) => row.body_omitted)).toBe(false)

    const { status, body: bodies } = await get('/api/app/conversations/c1/messages/bodies?ids=big,m1,missing')
    expect(status).toBe(200)
    expect(bodies.messages.map((row: TreeRow) => row.id)).toEqual(['m1', 'big'])
    expect(bodies.messages[1].content_blocks).toEqual(JSON.parse(blocks))
    expect(bodies.messages[1].body_omitted).toBeUndefined()
    expect(bodies.messages[0].attachments.map((a: { id: string }) => a.id)).toEqual(['att-a', 'att-b'])
    expect(bodies.messages[0].hook_runs).toHaveLength(505)
    expect((await get('/api/app/conversations/c1/messages/bodies')).status).toBe(400)

    const url = `${baseUrl}/api/app/conversations/c1/messages/tree?scope=branch&tip=tail&window=1`
    const first = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } })
    expect(first.headers.get('cache-control')).toBe('private, no-cache')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const unchanged = await conditional(url, etag!)
    expect(unchanged.status).toBe(304)
    expect(unchanged.body).toBe('')
    db.prepare(`UPDATE messages SET content = 'edited' WHERE id = 'tail'`).run()
    const changed = await conditional(url, etag!)
    expect(changed.status).toBe(200)
    expect(JSON.parse(changed.body).messages.at(-1).content).toBe('edited')
  })

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

  it('negotiates gzip for large finite snapshots without changing their decoded shape', async () => {
    const url = `${baseUrl}/api/app/conversations/c1/messages/tree?scope=branch`
    const compressed = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } })
    const identity = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } })
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(compressed.headers.get('vary')).toContain('Accept-Encoding')
    expect(identity.headers.get('content-encoding')).toBeNull()
    expect(Number(compressed.headers.get('content-length'))).toBeLessThan(Number(identity.headers.get('content-length')))
    expect(await compressed.json()).toEqual(await identity.json())
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
    expect(body.meta).toBeUndefined()
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
    expect(app.body).toEqual({ messages: [], tree: null })
    expect(gw.body).toEqual(app.body)
  })

  it('gateway serves a local conversation in-process and identically to the app route', async () => {
    const app = await get('/api/app/conversations/c1/messages/tree')
    const gw = await get('/api/gw/conversations/c1/messages/tree')
    expect(gw.status).toBe(200)
    expect(gw.body).toEqual(app.body)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('flat snapshots retain all enrichment and serialize a 20,000-deep conversation', async () => {
    const legacy = await get('/api/app/conversations/c1/messages/tree')
    for (const prefix of ['app', 'gw']) {
      const flat = await get(`/api/${prefix}/conversations/c1/messages/tree?includeTree=false`)
      expect(flat.status).toBe(200)
      expect(flat.body).toEqual({ ...legacy.body, tree: null })
    }
    const insert = db.prepare('INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    db.transaction(() => {
      for (let i = 0; i < 20000; i++) insert.run(`deep-${i}`, 'c-empty', i ? `deep-${i - 1}` : null,
        JSON.stringify(i < 19999 ? [`deep-${i + 1}`] : []), 'assistant', 'text', at(i))
    })()
    for (const prefix of ['app', 'gw']) {
      const flat = await get(`/api/${prefix}/conversations/c-empty/messages/tree?includeTree=false`)
      expect(flat.status).toBe(200)
      expect(flat.body.tree).toBeNull()
      expect(flat.body.messages).toHaveLength(20000)
      expect(flat.body.messages.at(-1).parent_id).toBe('deep-19998')
    }
  })

  it('gateway serves an unknown conversation locally, exactly like the app route', async () => {
    const app = await get('/api/app/conversations/not-local/messages/tree')
    const gw = await get('/api/gw/conversations/not-local/messages/tree')
    expect(gw).toEqual(app)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
