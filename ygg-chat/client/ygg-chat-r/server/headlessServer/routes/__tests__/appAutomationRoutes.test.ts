import type Database from 'better-sqlite3'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerAppAutomationRoutes } from '../appAutomationRoutes.js'
import { CLAUDE_SESSION_SCHEMA } from '../../persistence/claudeSessionRepo.js'
import { TOP_LEVEL_PREVIEW_MESSAGES_SQL, TOP_LEVEL_USER_MESSAGES_SQL } from '../../../topLevelUserMessages.js'

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
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      created_at TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      user_id TEXT,
      context TEXT,
      system_prompt TEXT,
      cwd TEXT,
      storage_mode TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      title TEXT,
      model_name TEXT,
      system_prompt TEXT,
      conversation_context TEXT,
      research_note TEXT,
      cwd TEXT,
      storage_mode TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      children_ids TEXT DEFAULT '[]',
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'ex_agent', 'tool')),
      content TEXT NOT NULL,
      plain_text_content TEXT,
      thinking_block TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      model_name TEXT,
      note TEXT,
      note_color TEXT,
      ex_agent_session_id TEXT,
      ex_agent_type TEXT,
      content_blocks TEXT,
      created_at TEXT,
      meta TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TRIGGER messages_children_insert AFTER INSERT ON messages
    WHEN NEW.parent_id IS NOT NULL
    BEGIN
      UPDATE messages
      SET children_ids = CASE
        WHEN children_ids = '[]' OR children_ids = '' THEN '["' || NEW.id || '"]'
        ELSE SUBSTR(children_ids, 1, LENGTH(children_ids)-1) || ',"' || NEW.id || '"]'
      END
      WHERE id = NEW.parent_id;
    END;
  `)
}

function createStatements(db: Database.Database): any {
  return {
    upsertUser: db.prepare(`
      INSERT INTO users (id, username, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username
    `),

    upsertProject: db.prepare(`
      INSERT INTO projects (id, name, user_id, context, system_prompt, cwd, storage_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        context = excluded.context,
        system_prompt = excluded.system_prompt,
        cwd = excluded.cwd,
        storage_mode = excluded.storage_mode,
        updated_at = excluded.updated_at
    `),
    getProjectById: db.prepare('SELECT * FROM projects WHERE id = ?'),

    upsertConversation: db.prepare(`
      INSERT INTO conversations (id, project_id, user_id, title, model_name, system_prompt, conversation_context, research_note, cwd, storage_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        model_name = excluded.model_name,
        system_prompt = excluded.system_prompt,
        conversation_context = excluded.conversation_context,
        research_note = excluded.research_note,
        cwd = excluded.cwd,
        storage_mode = excluded.storage_mode,
        updated_at = excluded.updated_at
    `),
    getConversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),

    upsertMessage: db.prepare(`
      INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, plain_text_content, thinking_block, tool_calls, tool_call_id, model_name, note, note_color, ex_agent_session_id, ex_agent_type, content_blocks, created_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        plain_text_content = excluded.plain_text_content,
        thinking_block = excluded.thinking_block,
        tool_calls = excluded.tool_calls,
        tool_call_id = excluded.tool_call_id,
        model_name = excluded.model_name,
        note = excluded.note,
        note_color = excluded.note_color,
        ex_agent_session_id = excluded.ex_agent_session_id,
        ex_agent_type = excluded.ex_agent_type,
        content_blocks = excluded.content_blocks
    `),
    updateMessage: db.prepare('UPDATE messages SET content = ?, note = ?, note_color = ?, content_blocks = ? WHERE id = ?'),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getMessagesByConversationId: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
    getTopLevelUserMessagesByConversationId: db.prepare(TOP_LEVEL_USER_MESSAGES_SQL),
    getTopLevelPreviewMessagesByConversationId: db.prepare(TOP_LEVEL_PREVIEW_MESSAGES_SQL),
  }
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describeIfSqlite('registerAppAutomationRoutes', () => {
  let db: Database.Database | undefined
  let appServer: Server | undefined
  let baseUrl = ''

  beforeEach(() => {
    if (!BetterSqlite3Ctor) {
      throw new Error('better-sqlite3 is unavailable in this runtime')
    }

    const database = new BetterSqlite3Ctor(':memory:')
    db = database
    createSchema(database)

    const app = express()
    app.use(express.json())
    registerAppAutomationRoutes(app, {
      db: database,
      statements: createStatements(database),
    })

    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    if (appServer) {
      await new Promise<void>((resolve, reject) => {
        appServer.close(error => {
          if (error) reject(error)
          else resolve()
        })
      })
    }

    if (db) {
      db.close()
    }
  })

  it('auto-creates missing users before creating local projects and conversations', async () => {
    const projectRes = await postJson(baseUrl, '/api/app/projects', {
      name: 'Quick Chat',
      user_id: 'u1',
    })

    expect(projectRes.status).toBe(201)
    const projectJson = (await projectRes.json()) as any
    expect(projectJson.user_id).toBe('u1')

    const persistedUser = db!.prepare('SELECT * FROM users WHERE id = ?').get('u1') as any
    expect(persistedUser).toBeTruthy()
    expect(persistedUser.id).toBe('u1')

    const conversationRes = await postJson(baseUrl, '/api/app/conversations', {
      title: 'Conv 1',
      user_id: 'u1',
      project_id: projectJson.id,
      cwd: '/tmp/repo',
    })

    expect(conversationRes.status).toBe(201)
    const conversationJson = (await conversationRes.json()) as any

    const persistedConversation = db!.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationJson.id) as any
    expect(persistedConversation.user_id).toBe('u1')
    expect(persistedConversation.project_id).toBe(projectJson.id)
    expect(persistedConversation.title).toBe('Conv 1')
    expect(persistedConversation.model_name).toBe('unknown')
    expect(persistedConversation.cwd).toBe('/tmp/repo')
    expect(persistedConversation.storage_mode).toBe('local')
  })

  it('previews real prompt branches beneath generated launch-context roots', async () => {
    const conversationRes = await postJson(baseUrl, '/api/app/conversations', {
      title: 'Preview Test', user_id: 'preview-user',
    })
    expect(conversationRes.status).toBe(201)
    const conversationId = ((await conversationRes.json()) as any).id as string
    const insert = db!.prepare(`INSERT INTO messages
      (id, conversation_id, parent_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    insert.run('reminder', conversationId, null, 'user', 'generated instructions', '2026-09-30T10:00:00Z',
      JSON.stringify({ kind: 'context_injection', reason: 'session_start' }))
    insert.run('prompt-a', conversationId, 'reminder', 'user', 'Original request', '2026-09-30T10:01:00Z', null)
    insert.run('prompt-b', conversationId, 'reminder', 'user', 'Edited request', '2026-09-30T10:02:00Z', null)
    insert.run('answer', conversationId, 'prompt-a', 'assistant', 'Answer', '2026-09-30T10:03:00Z', null)
    insert.run('follow-up', conversationId, 'answer', 'user', 'Later turn', '2026-09-30T10:04:00Z', null)

    const response = await fetch(`${baseUrl}/api/app/conversations/${conversationId}/messages/top-level-users`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { id: 'prompt-a', conversation_id: conversationId, content: 'Original request', role: 'user', parent_id: 'reminder', children_ids: '["answer"]',
        plain_text_content: null, note: null, note_color: null, created_at: '2026-09-30T10:01:00Z' },
      { id: 'prompt-b', conversation_id: conversationId, content: 'Edited request', role: 'user', parent_id: 'reminder', children_ids: '[]',
        plain_text_content: null, note: null, note_color: null, created_at: '2026-09-30T10:02:00Z' },
    ])
    expect((db!.prepare('SELECT parent_id FROM messages WHERE id = ?').get('prompt-a') as any).parent_id)
      .toBe('reminder')
  })

  it('returns latest conversation via single endpoint', async () => {
    const now = new Date().toISOString()

    db!.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run('latest-user', 'latest-user', now)

    db!.prepare(
      `
      INSERT INTO conversations (id, project_id, user_id, title, model_name, system_prompt, conversation_context, research_note, cwd, storage_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run('conv-old', null, 'latest-user', 'Old', 'unknown', null, null, null, null, 'local', now, '2026-01-01T00:00:00.000Z')

    db!.prepare(
      `
      INSERT INTO conversations (id, project_id, user_id, title, model_name, system_prompt, conversation_context, research_note, cwd, storage_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run('conv-new', null, 'latest-user', 'New', 'unknown', null, null, null, null, 'local', now, '2026-02-01T00:00:00.000Z')

    const latestRes = await fetch(`${baseUrl}/api/app/conversations/latest?userId=latest-user`)
    expect(latestRes.status).toBe(200)
    const latestPayload = (await latestRes.json()) as any
    expect(latestPayload.id).toBe('conv-new')

    const missingUserRes = await fetch(`${baseUrl}/api/app/conversations/latest`)
    expect(missingUserRes.status).toBe(400)
  })

  it('bulk-copies multiple branches without flattening their topology or sibling order', async () => {
    const conversationRes = await postJson(baseUrl, '/api/app/conversations', {
      title: 'Bulk Target',
      user_id: 'bulk-user',
    })
    expect(conversationRes.status).toBe(201)
    const conversationId = ((await conversationRes.json()) as any).id as string

    const bulkRes = await postJson(baseUrl, `/api/app/conversations/${conversationId}/messages/bulk`, {
      messages: [
        {
          source_id: 'root',
          parent_source_id: null,
          role: 'user',
          content: 'root',
          meta: { transfer: true },
        },
        { source_id: 'branch-b', parent_source_id: 'root', role: 'assistant', content: 'branch-b' },
        { source_id: 'branch-b-leaf', parent_source_id: 'branch-b', role: 'user', content: 'branch-b-leaf' },
        { source_id: 'branch-a', parent_source_id: 'root', role: 'assistant', content: 'branch-a' },
        { source_id: 'branch-a-leaf', parent_source_id: 'branch-a', role: 'tool', content: 'branch-a-leaf', tool_call_id: 'tool-1' },
      ],
    })

    expect(bulkRes.status).toBe(200)
    const created = ((await bulkRes.json()) as any).messages as any[]
    expect(created.map(message => message.content)).toEqual([
      'root',
      'branch-b',
      'branch-b-leaf',
      'branch-a',
      'branch-a-leaf',
    ])

    const byContent = new Map(created.map(message => [message.content, message]))
    expect(byContent.get('branch-b')?.parent_id).toBe(byContent.get('root')?.id)
    expect(byContent.get('branch-b-leaf')?.parent_id).toBe(byContent.get('branch-b')?.id)
    expect(byContent.get('branch-a')?.parent_id).toBe(byContent.get('root')?.id)
    expect(byContent.get('branch-a-leaf')?.parent_id).toBe(byContent.get('branch-a')?.id)

    const rootRecord = db!.prepare('SELECT * FROM messages WHERE id = ?').get(byContent.get('root')?.id) as any
    expect(JSON.parse(rootRecord.children_ids)).toEqual([
      byContent.get('branch-b')?.id,
      byContent.get('branch-a')?.id,
    ])
    // Provenance replaces any `transfer` the payload carried.
    expect(JSON.parse(rootRecord.meta)).toEqual({ transfer: { sourceMessageId: 'root' } })

    const leafRecord = db!.prepare('SELECT * FROM messages WHERE id = ?').get(byContent.get('branch-a-leaf')?.id) as any
    expect(leafRecord.tool_call_id).toBe('tool-1')
    expect(created.map(message => message.created_at)).toEqual([...created.map(message => message.created_at)].sort())
  })

  it('protects Claude transcript content and deletes only back to a resumable cut', async () => {
    const created = await postJson(baseUrl, '/api/app/conversations', { title: 'Claude', user_id: 'claude-user' })
    const conversationId = ((await created.json()) as any).id
    db!.exec(CLAUDE_SESSION_SCHEMA)
    const claudeMeta = JSON.stringify({ modelSelection: { provider: 'claudecode', model: 'm' } })
    const add = async (role: string, content: string, parent_id: string | null) => {
      const res = await postJson(baseUrl, '/api/app/messages', { conversation_id: conversationId, role, content, parent_id })
      const id = ((await res.json()) as any).id
      db!.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(claudeMeta, id)
      return id as string
    }
    const id = await add('user', 'original', null)
    const answer = await add('assistant', 'done', id)
    db!.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run(answer, 's', 'uuid', '/w')
    const followUp = await add('user', 'next', answer)
    const toolTurn = await add('assistant', 'working', followUp)
    const queued = await add('user', 'mid-turn', toolTurn)

    const edit = await fetch(`${baseUrl}/api/app/messages/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'changed' }) })
    expect(edit.status).toBe(409)
    const note = await fetch(`${baseUrl}/api/app/messages/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'my note' }) })
    expect(note.status).toBe(200)
    expect((await note.json() as any).content).toBe('original')

    // A mid-turn message would leave the branch on a tool row Claude cannot resume from.
    const refused = await fetch(`${baseUrl}/api/app/messages/${queued}`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect((await refused.json() as any).code).toBe('claude_delete_refused')
    expect((await postJson(baseUrl, '/api/app/messages/deleteMany', { ids: [queued] })).status).toBe(409)

    expect((await fetch(`${baseUrl}/api/app/messages/${followUp}`, { method: 'DELETE' })).status).toBe(200)
    expect(db!.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(conversationId).map((row: any) => row.id).sort())
      .toEqual([id, answer].sort())
    expect((await postJson(baseUrl, '/api/app/messages/deleteMany', { ids: [id, answer] })).status).toBe(200)
    expect(db!.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId)).toEqual({ n: 0 })
  })

  describe('Claude transfers', () => {
    const claude = { provider: 'claudecode', model: 'claude-opus-5-5' }
    let sourceId = ''
    let targetId = ''
    const payload = (ids: string[]) => ids.map(id => {
      const row = db!.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any
      return { source_id: id, parent_source_id: ids.includes(row.parent_id) ? row.parent_id : null, role: row.role, content: row.content, meta: row.meta }
    })
    const targetRows = () => db!.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at').all(targetId) as any[]

    beforeEach(async () => {
      db!.exec(CLAUDE_SESSION_SCHEMA)
      sourceId = ((await (await postJson(baseUrl, '/api/app/conversations', { title: 'Source', user_id: 'claude-user' })).json()) as any).id
      targetId = ((await (await postJson(baseUrl, '/api/app/conversations', { title: 'Target', user_id: 'claude-user' })).json()) as any).id
      const insert = db!.prepare('INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      const rows: Array<[string, string | null, string, string, Record<string, unknown>]> = [
        ['u0', null, 'user', 'start', { modelSelection: claude, toolAutoApprove: true }],
        ['a0', 'u0', 'assistant', 'done', { modelSelection: claude, toolAutoApprove: true, claude: { sessionId: 's', messageUuid: 'm0', checkpoint: true } }],
        ['i', 'a0', 'user', '/compact', { kind: 'compaction_instruction', sourceTipId: 'a0', modelSelection: claude }],
        ['s', 'i', 'assistant', 'Portable state', { kind: 'compaction_summary', state: 'committed', claude: { sessionId: 's', checkpoint: false },
          runStatistics: { kind: 'turn', streamId: 'stream-1' } }],
        ['u1', 's', 'user', 'more', { modelSelection: claude }],
        ['a1', 'u1', 'assistant', 'reply', { modelSelection: claude, claude: { sessionId: 's', messageUuid: 'm1', checkpoint: true } }],
        // Another provider, handed off from the summary.
        ['g1', 's', 'user', 'gpt', { modelSelection: { provider: 'openaichatgpt', model: 'gpt' }, executionHandoff: { summaryMessageId: 's' } }],
      ]
      rows.forEach(([id, parent, role, content, meta], index) =>
        insert.run(id, sourceId, parent, role, content, `2026-11-02T10:0${index}:00Z`, JSON.stringify(meta)))
      db!.prepare('INSERT INTO claude_message_checkpoints VALUES (?, ?, ?, ?, 1)').run('a0', 's', 'm0', '/w')
    })

    it('refuses a Claude selection that does not end at a summary and writes nothing', async () => {
      const res = await postJson(baseUrl, `/api/app/conversations/${targetId}/messages/bulk`, { messages: payload(['s', 'u1', 'a1']) })
      expect(res.status).toBe(409)
      expect(((await res.json()) as any).code).toBe('claude_transfer_requires_summary')
      // The selected tip alone does not show it is Claude; the server reads its ancestry.
      const tipOnly = await postJson(baseUrl, `/api/app/conversations/${targetId}/messages/bulk`, {
        messages: [{ source_id: 'a1', parent_source_id: null, role: 'assistant', content: 'reply', meta: null }],
      })
      expect(tipOnly.status).toBe(409)
      expect(targetRows()).toEqual([])
    })

    it('copies up to the summary and drops native identity, approval and dangling references', async () => {
      const res = await postJson(baseUrl, `/api/app/conversations/${targetId}/messages/bulk`, { messages: payload(['a0', 'i', 's']) })
      expect(res.status).toBe(200)
      const [answer, instruction, summary] = targetRows()
      const meta = (row: any) => JSON.parse(row.meta)
      expect(meta(answer)).toEqual({ modelSelection: claude, claude: { sessionId: 's', messageUuid: 'm0' },
        transfer: { sourceMessageId: 'a0', sourceConversationId: sourceId } })
      expect(meta(instruction).sourceTipId).toBe(answer.id)
      expect(meta(summary)).toEqual({ kind: 'compaction_summary', state: 'committed', claude: { sessionId: 's' },
        runStatistics: { kind: 'turn', streamId: 'copied:stream-1' }, transfer: { sourceMessageId: 's', sourceConversationId: sourceId } })
      // No native checkpoint or session is copied.
      expect(db!.prepare('SELECT COUNT(*) AS n FROM claude_message_checkpoints WHERE message_id IN (?, ?, ?)').get(answer.id, instruction.id, summary.id)).toEqual({ n: 0 })
    })

    it('drops a reference to a row outside the copy', async () => {
      // Without its parent selected, the compaction instruction loses its source tip.
      expect((await postJson(baseUrl, `/api/app/conversations/${targetId}/messages/bulk`, { messages: payload(['i', 's']) })).status).toBe(200)
      expect(JSON.parse(targetRows()[0].meta).sourceTipId).toBeUndefined()
    })

    it('keeps a handoff branch pointing at its copied summary, and drops it without the summary', async () => {
      expect((await postJson(baseUrl, `/api/app/conversations/${targetId}/messages/bulk`, { messages: payload(['s', 'g1']) })).status).toBe(200)
      const [summary, handoff] = targetRows()
      expect(JSON.parse(handoff.meta).executionHandoff).toEqual({ summaryMessageId: summary.id })
      expect((await postJson(baseUrl, `/api/app/conversations/${targetId}/messages/bulk`, { messages: payload(['g1']) })).status).toBe(200)
      expect(JSON.parse(targetRows()[2].meta).executionHandoff).toBeUndefined()
    })

    it('previews a delete without deleting, so Move can refuse before it copies', async () => {
      // Moving only the summary would leave the source on its /compact instruction, which Claude cannot continue from.
      const refused = await postJson(baseUrl, '/api/app/messages/deleteMany', { ids: ['s'], dryRun: true })
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as any).code).toBe('claude_delete_refused')
      // From the first prompt the cut lands on the root, which is allowed.
      const allowed = await postJson(baseUrl, '/api/app/messages/deleteMany', { ids: ['u0'], dryRun: true })
      expect(allowed.status).toBe(200)
      expect(((await allowed.json()) as any).planned).toEqual(['u0'])
      expect(db!.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(sourceId)).toEqual({ n: 7 })
    })

    it('lets a copied Claude branch be cut back to the copied summary', async () => {
      expect((await postJson(baseUrl, `/api/app/conversations/${targetId}/messages/bulk`, { messages: payload(['s']) })).status).toBe(200)
      const [summary] = targetRows()
      const add = db!.prepare('INSERT INTO messages (id, conversation_id, parent_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      add.run('n1', targetId, summary.id, 'user', 'new', '2026-11-03T00:00:00Z', JSON.stringify({ modelSelection: claude }))
      add.run('n2', targetId, 'n1', 'assistant', 'answer', '2026-11-03T00:01:00Z', JSON.stringify({ modelSelection: claude, claude: { sessionId: 'fresh', checkpoint: true } }))
      expect((await fetch(`${baseUrl}/api/app/messages/n1`, { method: 'DELETE' })).status).toBe(200)
      expect(targetRows().map(row => row.id)).toEqual([summary.id])
    })
  })

  it('rolls back the complete bulk copy when one message cannot be persisted', async () => {
    const conversationRes = await postJson(baseUrl, '/api/app/conversations', {
      title: 'Rollback Target',
      user_id: 'rollback-user',
    })
    expect(conversationRes.status).toBe(201)
    const conversationId = ((await conversationRes.json()) as any).id as string

    const bulkRes = await postJson(baseUrl, `/api/app/conversations/${conversationId}/messages/bulk`, {
      messages: [
        { source_id: 'root', parent_source_id: null, role: 'user', content: 'root' },
        { source_id: 'bad', parent_source_id: 'root', role: null, content: 'bad' },
      ],
    })

    expect(bulkRes.status).toBe(500)
    const count = db!.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(conversationId) as any
    expect(count.count).toBe(0)
  })

  it('tracks parent children_ids when creating and branching messages', async () => {
    const conversationRes = await postJson(baseUrl, '/api/app/conversations', {
      title: 'Tree Test',
      user_id: 'u2',
    })
    expect(conversationRes.status).toBe(201)

    const conversationJson = (await conversationRes.json()) as any
    const conversationId = conversationJson.id as string

    const rootRes = await postJson(baseUrl, '/api/app/messages', {
      conversation_id: conversationId,
      role: 'user',
      content: 'root',
    })
    expect(rootRes.status).toBe(201)
    const rootId = ((await rootRes.json()) as any).id as string

    const child1Res = await postJson(baseUrl, '/api/app/messages', {
      conversation_id: conversationId,
      parent_id: rootId,
      role: 'assistant',
      content: 'child-1',
    })
    expect(child1Res.status).toBe(201)
    const child1Id = ((await child1Res.json()) as any).id as string

    const child2Res = await postJson(baseUrl, `/api/app/messages/${rootId}/branch`, {
      role: 'assistant',
      content: 'child-2',
    })
    expect(child2Res.status).toBe(201)
    const child2Id = ((await child2Res.json()) as any).id as string

    const grandChildRes = await postJson(baseUrl, '/api/app/messages', {
      conversation_id: conversationId,
      parent_id: child1Id,
      role: 'tool',
      content: 'grand-child',
    })
    expect(grandChildRes.status).toBe(201)
    const grandChildId = ((await grandChildRes.json()) as any).id as string

    const rootRecord = db!.prepare('SELECT * FROM messages WHERE id = ?').get(rootId) as any
    expect(JSON.parse(rootRecord.children_ids ?? '[]')).toEqual([child1Id, child2Id])

    const child1Record = db!.prepare('SELECT * FROM messages WHERE id = ?').get(child1Id) as any
    expect(JSON.parse(child1Record.children_ids ?? '[]')).toEqual([grandChildId])
  })
})

// Exercise the public route, not only the persistence helper.
describeIfSqlite('message deletion lineage repair routes', () => {
  it.each(['single', 'bulk'])('repairs a deleted branch head through %s deletion', async kind => {
    const db = new BetterSqlite3Ctor!(':memory:')
    let server: Server | undefined
    try {
      createSchema(db)
      db.exec(`CREATE TABLE lineages (id TEXT PRIMARY KEY, conversation_id TEXT, head_message_id TEXT,
        root_message_id TEXT, forked_from_message_id TEXT, status TEXT, updated_at TEXT);
        INSERT INTO users (id, username) VALUES ('u', 'user');
        INSERT INTO conversations (id, user_id) VALUES ('c', 'u');
        INSERT INTO messages (id, conversation_id, parent_id, role, content) VALUES ('parent', 'c', NULL, 'user', 'hello');
        INSERT INTO messages (id, conversation_id, parent_id, role, content) VALUES ('answer', 'c', 'parent', 'assistant', 'reply');
        INSERT INTO lineages VALUES ('l', 'c', 'answer', 'parent', NULL, 'active', 'before');`)
      const app = express(); app.use(express.json())
      registerAppAutomationRoutes(app, { db, statements: createStatements(db) })
      server = app.listen(0)
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const response = kind === 'single'
        ? await fetch(`${url}/api/app/messages/answer`, { method: 'DELETE' })
        : await postJson(url, '/api/app/messages/deleteMany', { ids: ['answer'] })
      expect(response.status).toBe(200)
      expect(db.prepare('SELECT head_message_id FROM lineages WHERE id = ?').get('l')).toEqual({ head_message_id: 'parent' })
      expect(db.prepare('SELECT children_ids FROM messages WHERE id = ?').get('parent')).toEqual({ children_ids: '[]' })
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
      db.close()
    }
  })
})
