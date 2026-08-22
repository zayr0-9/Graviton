import type Database from 'better-sqlite3'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerAppAutomationRoutes } from '../appAutomationRoutes.js'

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
      role TEXT,
      content TEXT,
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
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
    );
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
      INSERT INTO projects (id, name, user_id, context, system_prompt, storage_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        context = excluded.context,
        system_prompt = excluded.system_prompt,
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
      INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, plain_text_content, thinking_block, tool_calls, tool_call_id, model_name, note, note_color, ex_agent_session_id, ex_agent_type, content_blocks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getMessagesByConversationId: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
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
