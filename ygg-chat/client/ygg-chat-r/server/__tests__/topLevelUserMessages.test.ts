import express from 'express'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INSTRUCTION_SET_PREAMBLE } from '../../../../shared/contextInjection.js'
import { registerAppAutomationRoutes } from '../headlessServer/routes/appAutomationRoutes.js'
import { registerConversationRoutes } from '../routes/conversationRoutes.js'
import { TOP_LEVEL_USER_MESSAGES_SQL } from '../topLevelUserMessages.js'

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
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL,
      content TEXT NOT NULL, plain_text_content TEXT, note TEXT, note_color TEXT, created_at TEXT,
      meta TEXT, content_blocks TEXT, children_ids TEXT DEFAULT '[]'
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
      created_at: '2026-09-30T11:00:00Z',
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
