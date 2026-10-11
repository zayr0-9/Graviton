import express from 'express'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INSTRUCTION_SET_PREAMBLE } from '../../../../shared/contextInjection.js'
import { registerAppAutomationRoutes } from '../headlessServer/routes/appAutomationRoutes.js'
import { registerConversationRoutes } from '../routes/conversationRoutes.js'
import {
  TOP_LEVEL_USER_MESSAGES_SQL,
  TOP_LEVEL_USER_MESSAGE_SEARCH_REBUILD_SQL,
  TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL,
  TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES,
} from '../topLevelUserMessages.js'
import { registerNoteSearchRoutes } from '../routes/noteSearchRoutes.js'

const require = createRequire(import.meta.url)

function openDatabase(): any {
  try {
    const Database = require('better-sqlite3')
    return new Database(':memory:')
  } catch {
    // Electron's native addon may not load under Node. Run the real query with
    // Node's SQLite instead; do not skip these regressions or rebuild the addon.
    const { DatabaseSync } = require('node:sqlite')
    return new DatabaseSync(':memory:')
  }
}

const injectionMeta = JSON.stringify({ kind: 'context_injection', files: [], reason: 'session_start' })
const reminder = `<system-reminder>\n${INSTRUCTION_SET_PREAMBLE}\n</system-reminder>`

describe('shared human top-level message selector', () => {
  let db: any
  let server: Server | undefined

  const addMessage = (id: string, parentId: string | null = null, options: {
    role?: string; meta?: string | null; content?: string; conversationId?: string; createdAt?: string
  } = {}) => {
    db.prepare(`INSERT INTO messages
      (id, conversation_id, parent_id, role, content, plain_text_content, note, note_color, created_at, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, options.conversationId ?? 'conversation-1', parentId, options.role ?? 'user',
        options.content ?? id, `plain ${id}`, `note ${id}`, '#123456', options.createdAt ?? id, options.meta ?? null)
  }
  const selectMessages = () => db.prepare(TOP_LEVEL_USER_MESSAGES_SQL).all('conversation-1')
  const selectedIds = () => selectMessages().map((row: any) => row.id)

  beforeEach(() => {
    db = openDatabase()
    // Malformed-tree regressions intentionally insert orphans/out-of-order rows.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL,
      content TEXT NOT NULL, plain_text_content TEXT, note TEXT, note_color TEXT, created_at TEXT,
      meta TEXT, content_blocks TEXT, children_ids TEXT DEFAULT '[]',
      FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE CASCADE
    )`)
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
      server = undefined
    }
    db.close()
  })

  it('preserves ordinary roots, response fields, and chronological order', () => {
    addMessage('later', null, { createdAt: '2026-09-30T12:00:00Z' })
    addMessage('earlier', null, { createdAt: '2026-09-30T11:00:00Z' })
    expect(selectedIds()).toEqual(['earlier', 'later'])
    expect(selectMessages()[0]).toEqual({
      id: 'earlier', conversation_id: 'conversation-1', content: 'earlier',
      plain_text_content: 'plain earlier', note: 'note earlier', note_color: '#123456',
      created_at: '2026-09-30T11:00:00Z', role: 'user', parent_id: null, children_ids: '[]',
    })
  })

  it('replaces a generated root with all real prompt branches without rewriting the tree', () => {
    addMessage('reminder', null, { meta: injectionMeta, content: reminder })
    addMessage('prompt-a', 'reminder')
    addMessage('prompt-b', 'reminder')
    const before = db.prepare('SELECT * FROM messages ORDER BY id').all()
    expect(selectedIds()).toEqual(['prompt-a', 'prompt-b'])
    expect(db.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(before)
  })

  it('promotes real prompts through Full access notices without previewing the generated reminder', () => {
    addMessage('context', null, { meta: injectionMeta })
    addMessage('access', 'context', { meta: JSON.stringify({ kind: 'full_access_change', requestId: 'toggle-1' }) })
    addMessage('prompt', 'access')
    addMessage('reply', 'prompt', { role: 'assistant' })
    addMessage('follow-up', 'reply')
    expect(selectedIds()).toEqual(['prompt'])
  })

  it('orders promoted branches together with ordinary roots by their real timestamps', () => {
    addMessage('reminder', null, { meta: injectionMeta, createdAt: '2026-09-30T10:00:00Z' })
    addMessage('last-prompt', 'reminder', { createdAt: '2026-09-30T13:00:00Z' })
    addMessage('ordinary-root', null, { createdAt: '2026-09-30T12:00:00Z' })
    addMessage('first-prompt', 'reminder', { createdAt: '2026-09-30T11:00:00Z' })
    expect(selectedIds()).toEqual(['first-prompt', 'ordinary-root', 'last-prompt'])
  })

  it('traverses only consecutive tagged generated roots', () => {
    addMessage('reminder', null, { meta: injectionMeta })
    addMessage('second-reminder', 'reminder', { meta: injectionMeta })
    addMessage('prompt', 'second-reminder')
    addMessage('assistant', 'prompt', { role: 'assistant' })
    addMessage('later-prompt', 'assistant')
    expect(selectedIds()).toEqual(['prompt'])
  })

  it('does not promote mid-branch or post-compaction injection children', () => {
    addMessage('root')
    addMessage('assistant', 'root', { role: 'assistant' })
    addMessage('summary', 'assistant', { role: 'system' })
    addMessage('reminder', 'summary', { meta: JSON.stringify({ kind: 'context_injection', reason: 'compact' }) })
    addMessage('later-prompt', 'reminder')
    expect(selectedIds()).toEqual(['root'])
  })

  it('keeps untagged reminder text and prompts carrying injection blocks visible', () => {
    addMessage('quoted-reminder', null, { content: reminder })
    addMessage('with-blocks')
    db.prepare('UPDATE messages SET content_blocks = ? WHERE id = ?')
      .run(JSON.stringify([{ type: 'context_injection', reason: 'hook', text: reminder }]), 'with-blocks')
    expect(selectedIds()).toEqual(['quoted-reminder', 'with-blocks'])
  })

  it.each([null, '', '{broken', '{}', 'null', '[]', '{"kind":null}', '{"kind":"operation_mode_change"}'])(
    'treats missing, invalid, or unrelated metadata as ordinary (%s)', meta => {
      addMessage('root', null, { meta })
      addMessage('child', 'root')
      expect(selectedIds()).toEqual(['root'])
    }
  )

  it.each(['assistant', 'system', 'tool', 'ex_agent'])(
    'does not make a %s root transparent', role => {
      addMessage('non-user-root', null, { role, meta: injectionMeta })
      addMessage('child', 'non-user-root')
      expect(selectedIds()).toEqual([])
    }
  )

  it('isolates conversations and ignores disconnected cycles and orphaned messages', () => {
    addMessage('reminder', null, { meta: injectionMeta })
    addMessage('prompt', 'reminder')
    addMessage('foreign-child', 'reminder', { conversationId: 'conversation-2' })
    addMessage('foreign-root', null, { conversationId: 'conversation-2' })
    addMessage('orphan', 'missing')
    addMessage('cycle-a', 'cycle-b', { meta: injectionMeta })
    addMessage('cycle-b', 'cycle-a', { meta: injectionMeta })
    expect(selectedIds()).toEqual(['prompt'])
  })

  it('returns no rows for empty or injection-only conversations', () => {
    expect(selectedIds()).toEqual([])
    addMessage('reminder', null, { meta: injectionMeta })
    expect(selectedIds()).toEqual([])
  })

  const indexIds = () => db.prepare('SELECT message_id FROM top_level_user_message_search ORDER BY message_id')
    .all().map((row: any) => row.message_id)
  const indexRowids = () => db.prepare('SELECT rowid FROM top_level_user_message_search ORDER BY rowid')
    .all().map((row: any) => row.rowid)
  const triggerNames = () => db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'top_level_user_message_search%' ORDER BY name`
  ).all().map((row: any) => row.name)
  const expectedTriggerNames = [...TOP_LEVEL_USER_MESSAGE_SEARCH_TRIGGER_NAMES].sort()

  it('backfills the index from the hover selector and replaces legacy triggers', () => {
    addMessage('context', null, { meta: injectionMeta })
    addMessage('access', 'context', { meta: JSON.stringify({ kind: 'full_access_change' }) })
    addMessage('prompt-a', 'access')
    addMessage('prompt-b', 'access')
    addMessage('ordinary')
    addMessage('reply', 'prompt-a', { role: 'assistant' })
    addMessage('follow-up', 'reply')
    addMessage('orphan', 'missing')
    addMessage('foreign-child', 'context', { conversationId: 'conversation-2' })
    db.exec(`CREATE TRIGGER top_level_user_message_search_insert AFTER INSERT ON messages BEGIN SELECT 1; END;`)
    db.exec(`CREATE TRIGGER top_level_user_message_search_update AFTER UPDATE ON messages BEGIN SELECT 1; END;`)
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_REBUILD_SQL)
    expect(indexIds()).toEqual([...selectedIds()].sort())
    expect(triggerNames()).toEqual(expectedTriggerNames)
    addMessage('prompt-c', 'access')
    expect(indexIds()).toEqual([...selectedIds()].sort())
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_REBUILD_SQL)
    expect(indexIds()).toEqual([...selectedIds()].sort())
  })

  it('boot schema is create-only: running it again keeps index rows and triggers', () => {
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('root')
    db.exec(`INSERT INTO top_level_user_message_search (rowid, message_id, content, plain_text_content, note)
      VALUES (999, 'sentinel', 'sentinel', '', '')`)
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    expect(indexIds()).toEqual(['root', 'sentinel'])
    expect(triggerNames()).toEqual(expectedTriggerNames)
  })

  it('keys index rows by the message rowid and ignores ordinary follow-up turns', () => {
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('root')
    addMessage('reply', 'root', { role: 'assistant' })
    addMessage('follow-up', 'reply')
    addMessage('tool-result', 'follow-up', { role: 'tool' })
    expect(indexIds()).toEqual(['root'])
    const rootRowid = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('root').rowid
    expect(indexRowids()).toEqual([rootRowid])
    // Streaming content updates and children_ids maintenance must not disturb the index.
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('streamed delta', 'reply')
    db.prepare('UPDATE messages SET children_ids = ? WHERE id = ?').run('["reply"]', 'root')
    expect(indexRowids()).toEqual([rootRowid])
    db.prepare('UPDATE messages SET note = ? WHERE id = ?').run('rootnote', 'follow-up')
    expect(db.prepare(`SELECT message_id FROM top_level_user_message_search WHERE top_level_user_message_search MATCH ?`)
      .all('rootnote')).toEqual([])
    db.prepare('DELETE FROM messages WHERE id = ?').run('root')
    expect(db.prepare('SELECT count(*) AS n FROM top_level_user_message_search WHERE rowid = ?').get(rootRowid).n).toBe(0)
  })

  it('keeps the index aligned after ancestor changes, note edits, reparenting, and deletes', () => {
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('context', null, { meta: injectionMeta })
    addMessage('prompt', 'context')
    addMessage('child', 'prompt')
    expect(indexIds()).toEqual(['prompt'])
    db.prepare('UPDATE messages SET note = ? WHERE id = ?').run('uniquenote', 'prompt')
    expect(db.prepare(`SELECT message_id FROM top_level_user_message_search WHERE top_level_user_message_search MATCH ?`)
      .all('uniquenote').map((row: any) => row.message_id)).toEqual(['prompt'])
    db.prepare('UPDATE messages SET meta = NULL WHERE id = ?').run('context')
    expect(indexIds()).toEqual(['context'])
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(injectionMeta, 'context')
    expect(indexIds()).toEqual(['prompt'])
    db.prepare('UPDATE messages SET parent_id = NULL WHERE id = ?').run('child')
    expect(indexIds()).toEqual(['child', 'prompt'])
    db.prepare('UPDATE messages SET role = ? WHERE id = ?').run('assistant', 'prompt')
    expect(indexIds()).toEqual(['child'])
    db.prepare('DELETE FROM messages WHERE id = ?').run('context')
    expect(indexIds()).toEqual(['child'])
    db.prepare('DELETE FROM messages WHERE id = ?').run('child')
    expect(indexIds()).toEqual([])
  })

  it('indexes out-of-order mirrored prompts and refreshes both conversations when moved', () => {
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('prompt', 'context')
    expect(indexIds()).toEqual([])
    addMessage('context', null, { meta: injectionMeta })
    expect(indexIds()).toEqual(['prompt'])
    db.prepare('UPDATE messages SET conversation_id = ? WHERE id = ?').run('conversation-2', 'context')
    expect(indexIds()).toEqual([])
    db.prepare('UPDATE messages SET conversation_id = ? WHERE id = ?').run('conversation-2', 'prompt')
    expect(indexIds()).toEqual(['prompt'])
    db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run('missing', 'context')
    expect(indexIds()).toEqual([])
    db.prepare('UPDATE messages SET parent_id = NULL WHERE id = ?').run('context')
    expect(indexIds()).toEqual(['prompt'])
  })

  it('removes indexed descendants on cascading deletes', () => {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('context', null, { meta: injectionMeta })
    addMessage('prompt-a', 'context')
    addMessage('prompt-b', 'context')
    expect(indexIds()).toEqual(['prompt-a', 'prompt-b'])
    db.prepare('DELETE FROM messages WHERE id = ?').run('context')
    expect(indexIds()).toEqual([])
    expect(selectedIds()).toEqual([])
  })

  it.each([true, false])('searches the hover-visible prompts and notes on both endpoints (FTS: %s)', async useFts => {
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, user_id TEXT, project_id TEXT, storage_mode TEXT,
      title TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO conversations VALUES ('conversation-1', 'user-1', 'project-1', 'local', 'Title', '2026-10-01', '2026-10-01');
    INSERT INTO conversations VALUES ('conversation-2', 'user-2', 'project-2', 'local', 'Other', '2026-10-01', '2026-10-01');`)
    if (useFts) db.exec(TOP_LEVEL_USER_MESSAGE_SEARCH_SCHEMA_SQL)
    addMessage('context', null, { meta: injectionMeta })
    addMessage('access', 'context', { meta: JSON.stringify({ kind: 'full_access_change' }) })
    addMessage('prompt-a', 'access')
    addMessage('prompt-b', 'access')
    addMessage('ordinary')
    addMessage('reply', 'prompt-a', { role: 'assistant' })
    addMessage('follow-up', 'reply')
    addMessage('orphan', 'missing')
    addMessage('foreign', null, { conversationId: 'conversation-2' })
    db.prepare('UPDATE messages SET content = ?, plain_text_content = ?, note = ?')
      .run('contentneedle', 'plainneedle', 'noteneedle')
    const app = express()
    registerAppAutomationRoutes(app, { db, statements: {} })
    registerNoteSearchRoutes(app, {
      db, statements: {}, getSqliteVecAvailable: () => false, getSqliteVecLoadError: () => null,
    })
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve)
      server.once('error', reject)
    })
    const { port } = server!.address() as AddressInfo
    for (const prefix of ['app', 'local']) {
      for (const query of ['plainneedle', 'noteneedle', 'noteneedlz']) {
        const response = await fetch(`http://127.0.0.1:${port}/api/${prefix}/conversations/search/top-level-users?userId=user-1&projectId=project-1&q=${query}`)
        expect(response.status).toBe(200)
        const hits = await response.json() as any[]
        expect(hits.map(hit => hit.message_id).sort()).toEqual([...selectedIds()].sort())
        expect(hits.every(hit => hit.match_type === (useFts && query !== 'noteneedlz' ? 'fts' : 'fuzzy'))).toBe(true)
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/${prefix}/conversations/search/top-level-users?userId=user-1&projectId=other&q=noteneedle`)
      expect(await response.json()).toEqual([])
    }
  })

  it('serves the same real prompt IDs and compact payload from app and legacy endpoints', async () => {
    addMessage('reminder', null, { meta: injectionMeta, content: reminder })
    addMessage('prompt-a', 'reminder')
    addMessage('prompt-b', 'reminder')
    const app = express()
    const deps = { db, statements: { getTopLevelUserMessagesByConversationId: db.prepare(TOP_LEVEL_USER_MESSAGES_SQL) } }
    registerAppAutomationRoutes(app, deps)
    registerConversationRoutes(app, deps)
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve)
      server.once('error', reject)
    })
    const { port } = server!.address() as AddressInfo
    for (const prefix of ['app', 'local']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/${prefix}/conversations/conversation-1/messages/top-level-users`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(selectMessages())
    }
  })
})
