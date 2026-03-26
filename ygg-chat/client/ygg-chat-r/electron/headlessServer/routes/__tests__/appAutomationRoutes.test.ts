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
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      user_id TEXT,
      context TEXT,
      system_prompt TEXT,
      storage_mode TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT,
      title TEXT,
      model_name TEXT,
      system_prompt TEXT,
      conversation_context TEXT,
      research_note TEXT,
      cwd TEXT,
      storage_mode TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      parent_id TEXT,
      children_ids TEXT,
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
      created_at TEXT
    );
  `)
}

function createStatements(db: Database.Database): any {
  return {
    upsertProject: db!.prepare(`
      INSERT INTO projects (id, name, user_id, context, system_prompt, storage_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        context = excluded.context,
        system_prompt = excluded.system_prompt,
        storage_mode = excluded.storage_mode,
        updated_at = excluded.updated_at
    `),
    getProjectById: db!.prepare('SELECT * FROM projects WHERE id = ?'),

    upsertConversation: db!.prepare(`
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
    getConversationById: db!.prepare('SELECT * FROM conversations WHERE id = ?'),
    updateConversationCwd: db!.prepare('UPDATE conversations SET cwd = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
    updateConversationProjectId: db!.prepare(
      'UPDATE conversations SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ),
    updateConversationResearchNote: db!.prepare(
      'UPDATE conversations SET research_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ),

    upsertMessage: db!.prepare(`
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
    getMessageById: db!.prepare('SELECT * FROM messages WHERE id = ?'),
    getMessagesByConversationId: db!.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
  }
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function deleteJson(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' })
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
        appServer.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }

    if (db) {
      db.close()
    }
  })

  it('creates conversations with correct upsertConversation parameter order', async () => {
    const projectRes = await postJson(baseUrl, '/api/app/projects', {
      name: 'P1',
      user_id: 'u1',
    })
    expect(projectRes.status).toBe(201)
    const projectJson = (await projectRes.json()) as any

    const createConversationRes = await postJson(baseUrl, '/api/app/conversations', {
      title: 'Conv 1',
      user_id: 'u1',
      project_id: projectJson.project.id,
      cwd: '/tmp/repo',
      storage_mode: 'local',
    })

    expect(createConversationRes.status).toBe(201)
    const payload = (await createConversationRes.json()) as any
    expect(payload.success).toBe(true)

    const persisted = db!.prepare('SELECT * FROM conversations WHERE id = ?').get(payload.conversation.id) as any
    expect(persisted.user_id).toBe('u1')
    expect(persisted.project_id).toBe(projectJson.project.id)
    expect(persisted.title).toBe('Conv 1')
    expect(persisted.model_name).toBe('unknown')
    expect(persisted.cwd).toBe('/tmp/repo')
    expect(persisted.storage_mode).toBe('local')
  })

  it('returns latest conversation via single endpoint', async () => {
    const now = new Date().toISOString()

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

  it('maintains message tree invariants for children_ids and recursive deletes', async () => {
    const convRes = await postJson(baseUrl, '/api/app/conversations', {
      title: 'Tree Test',
      user_id: 'u2',
    })
    const convJson = (await convRes.json()) as any
    const conversationId = convJson.conversation.id as string

    const rootRes = await postJson(baseUrl, '/api/app/messages', {
      conversation_id: conversationId,
      role: 'user',
      content: 'root',
    })
    const rootId = ((await rootRes.json()) as any).message.id as string

    const child1Res = await postJson(baseUrl, '/api/app/messages', {
      conversation_id: conversationId,
      parent_id: rootId,
      role: 'assistant',
      content: 'child-1',
    })
    const child1Id = ((await child1Res.json()) as any).message.id as string

    const child2Res = await postJson(baseUrl, `/api/app/messages/${rootId}/branch`, {
      role: 'assistant',
      content: 'child-2',
    })
    const child2Id = ((await child2Res.json()) as any).message.id as string

    const grandChildRes = await postJson(baseUrl, '/api/app/messages', {
      conversation_id: conversationId,
      parent_id: child1Id,
      role: 'tool',
      content: 'grand-child',
    })
    const grandChildId = ((await grandChildRes.json()) as any).message.id as string

    const rootBeforeDelete = db!.prepare('SELECT * FROM messages WHERE id = ?').get(rootId) as any
    const rootChildrenBeforeDelete = JSON.parse(rootBeforeDelete.children_ids ?? '[]') as string[]
    expect(rootChildrenBeforeDelete.sort()).toEqual([child1Id, child2Id].sort())

    const deleteRes = await deleteJson(baseUrl, `/api/app/messages/${child1Id}`)
    expect(deleteRes.status).toBe(200)

    const deletedChild1 = db!.prepare('SELECT * FROM messages WHERE id = ?').get(child1Id)
    const deletedGrandChild = db!.prepare('SELECT * FROM messages WHERE id = ?').get(grandChildId)
    const survivingChild2 = db!.prepare('SELECT * FROM messages WHERE id = ?').get(child2Id) as any
    const rootAfterDelete = db!.prepare('SELECT * FROM messages WHERE id = ?').get(rootId) as any
    const rootChildrenAfterDelete = JSON.parse(rootAfterDelete.children_ids ?? '[]') as string[]

    expect(deletedChild1).toBeUndefined()
    expect(deletedGrandChild).toBeUndefined()
    expect(survivingChild2).toBeTruthy()
    expect(survivingChild2.parent_id).toBe(rootId)
    expect(rootChildrenAfterDelete).toEqual([child2Id])
  })
})
