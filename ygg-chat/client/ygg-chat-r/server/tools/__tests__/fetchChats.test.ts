import { describe, expect, it, vi } from 'vitest'
import { execute, type FetchChatsArgs } from '../fetchChats.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions.js'

const chat = { id: 'c', title: 'Chat', user_id: 'u', project_id: 'p', updated_at: '2026-10-01T00:00:00Z' }
const message = (id: string, extra: Record<string, any> = {}) => ({ id, conversation_id: 'c', role: 'user',
  parent_id: null, children_ids: [], created_at: '2026-10-01T00:00:00Z', content: 'body', plain_text_content: 'plain body', note: 'note', ...extra })
function setup(messages = [message('m')], chats = [chat]) {
  return { listConversations: () => chats, getConversationById: (id: string) => chats.find(c => c.id === id),
    listMessagesByConversationId: () => messages, getMessageById: (id: string) => messages.find(m => m.id === id),
    listTopLevelUserMessagesByConversationId: vi.fn(() => messages.filter(m => m.role === 'user')),
    countTopLevelUserMessages: vi.fn(() => messages.filter(m => m.role === 'user').length) }
}

describe('fetch_chats bounded response contract', () => {
  it('defaults discovery to metadata without loading message bodies', async () => {
    const options = setup([message('m', { content: 'x'.repeat(1000000) })])
    const result = await execute({ includeContentPreview: false }, options)
    expect(result.chats).toEqual([{ id: 'c', title: 'Chat', created_at: null, updated_at: chat.updated_at, rootMessageCount: 1 }])
    expect(options.listTopLevelUserMessagesByConversationId).not.toHaveBeenCalled()
  })

  it('preview and notes omit full bodies, full uses one representation', async () => {
    for (const mode of ['preview', 'notes', 'full'] as const) {
      const result = await execute({ action: 'read_branch', messageId: 'm', responseMode: mode, previewChars: 20 }, setup())
      const record: any = result.branchMessages![0]
      expect(record).not.toHaveProperty('plain_text_content')
      expect(record).not.toHaveProperty('previewChars')
      if (mode === 'preview') { expect(record.content_preview).toBe('plain body'); expect(record).not.toHaveProperty('content') }
      if (mode === 'notes') { expect(record.note).toBe('note'); expect(record).not.toHaveProperty('content') }
      if (mode === 'full') expect(record.content).toBe('plain body')
    }
    const notes = await execute({ action: 'get_notes', conversationId: 'c' }, setup())
    expect(notes.notes![0]).toEqual({ id: 'm', conversation_id: 'c', created_at: chat.updated_at, note: 'note' })
  })

  it('walks through excluded tool/context/compaction nodes without returning them', async () => {
    const messages = [message('m', { children_ids: ['tool'] }), message('tool', { role: 'tool', children_ids: ['context'] }),
      message('context', { meta: '{"kind":"context_injection"}', children_ids: ['summary'] }),
      message('summary', { role: 'system', note: '__auto_compaction_summary__', children_ids: ['answer'] }),
      message('answer', { role: 'assistant' })]
    const result = await execute({ action: 'read_branch', messageId: 'm' }, setup(messages))
    expect(result.branchMessages!.map(m => m.id)).toEqual(['m', 'answer'])
    const all = await execute({ action: 'read_branch', messageId: 'm', includeToolMessages: true, includeSyntheticMessages: true }, setup(messages))
    expect(all.branchMessages).toHaveLength(5)
  })

  it('continues a single huge message without violating serialized budget', async () => {
    const text = ('quote " newline\n emoji 😀 ').repeat(400)
    const options = setup([message('m', { plain_text_content: text, note: null })])
    const args: FetchChatsArgs = { action: 'read_branch', messageId: 'm', responseMode: 'full', maxOutputChars: 2000 }
    let cursor: string | undefined
    let combined = ''
    let pages = 0
    do {
      const result = await execute({ ...args, cursor }, options)
      expect(result.success).toBe(true)
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000)
      const chunk = result.branchMessages![0].content!
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
      combined += chunk
      cursor = result.nextCursor
      expect(++pages).toBeLessThan(100)
    } while (cursor)
    expect(combined).toBe(text)
    expect(pages).toBeGreaterThan(1)
  })

  it('budgets every action, including huge notes and multi-record pages', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => message(`m${i}`, { note: 'n'.repeat(3000) }))
    const options = { ...setup(messages), searchNotes: () => messages.map(m => ({ message_id: m.id, note: m.note })) }
    for (const args of [
      { action: 'get_notes', conversationId: 'c' },
      { action: 'search_notes', userId: 'u', query: 'note' },
      { action: 'get_chats', conversationId: 'c', responseMode: 'notes' },
    ] as FetchChatsArgs[]) {
      const result = await execute({ ...args, maxOutputChars: 2000 }, options)
      expect(result.success).toBe(true)
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000)
      expect(result.truncated).toBe(true)
      expect(result.nextCursor).toBeTruthy()
      expect(result.omittedChars).toBeGreaterThan(0)
    }
    const chats = Array.from({ length: 100 }, (_, i) => ({ ...chat, id: `c${String(i).padStart(3, '0')}`, title: 't'.repeat(50) }))
    const first = await execute({ limit: 100, maxOutputChars: 2000 }, setup([], chats))
    expect(first.returnedCount).toBeGreaterThan(0)
    expect(first.omittedCount).toBeGreaterThan(0)
    const second = await execute({ limit: 100, maxOutputChars: 2000, cursor: first.nextCursor }, setup([], chats))
    expect(second.chats![0].id).toBe(chats[first.returnedCount!].id)
  })

  it('paginates metadata and applies filters before selecting results', async () => {
    const options = setup([], [chat, { ...chat, id: 'other', project_id: 'other' }, { ...chat, id: 'second' }])
    const args: FetchChatsArgs = { projectId: 'p', updatedAfter: '2026-09-01', updatedBefore: '2026-11-01', limit: 1 }
    const first = await execute(args, options)
    const second = await execute({ ...args, cursor: first.nextCursor }, options)
    expect(first.chats!.map(c => c.id)).toEqual(['c'])
    expect(second.chats!.map(c => c.id)).toEqual(['second'])
    expect(second.hasMore).toBe(false)
    expect((await execute({ ...args, projectId: 'other', cursor: first.nextCursor }, options)).success).toBe(false)
  })

  it('binds cursors to effective scope, not argument ordering or explicit defaults', async () => {
    const options = { ...setup([], [chat, { ...chat, id: 'second' }]), currentConversationId: 'c' }
    const first = await execute({ projectId: 'p', limit: 1 }, options)
    const next = await execute({ cursor: first.nextCursor, limit: 1, projectId: 'p', action: 'list_chats', responseMode: 'metadata', previewChars: 180 }, options)
    expect(next.success).toBe(true)
    expect(next.chats![0].id).toBe('second')
    const changed = await execute({ projectId: 'p', limit: 1, cursor: first.nextCursor }, { ...options, currentConversationId: 'other' })
    expect(changed.success).toBe(false)
  })

  it('pages roots separately and rejects invalid actions/dates/cursors', async () => {
    const result = await execute({ action: 'get_chats', conversationId: 'c', responseMode: 'preview', messageLimit: 1 }, setup([message('a'), message('b')]))
    expect(result.chats![0].top_level_messages).toHaveLength(1)
    expect(result.nextMessageSkip).toBe(1)
    expect((await execute({ action: 'oops' as any }, setup())).success).toBe(false)
    expect((await execute({ updatedAfter: 'invalid' }, setup())).success).toBe(false)
    expect((await execute({ cursor: 'invalid' }, setup())).success).toBe(false)
  })

  it('advertises bounded response modes and aggregate file limits', () => {
    const chats = BUILTIN_TOOL_DEFINITIONS.find(t => t.name === 'fetch_chats')!
    expect(chats.inputSchema.properties.responseMode.enum).toEqual(['metadata', 'notes', 'preview', 'full'])
    expect(chats.inputSchema.properties.maxOutputChars.minimum).toBe(2000)
    const files = BUILTIN_TOOL_DEFINITIONS.find(t => t.name === 'read_files')!
    expect(files.description).not.toContain('structured files array')
    expect(files.inputSchema.properties.maxBytes.description).toContain('Total UTF-8 byte budget')
  })
})

describe('tool discovery SQL (no migrations)', () => {
  it('filters and pages in SQLite, and counts promoted human roots', async () => {
    const { createRequire } = await import('node:module')
    const { readFileSync } = await import('node:fs')
    const { TOP_LEVEL_USER_MESSAGES_SQL } = await import('../../topLevelUserMessages.js')
    const require = createRequire(import.meta.url)
    let db: any
    try { const Database = require('better-sqlite3'); db = new Database(':memory:') }
    catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(':memory:') }
    try {
      db.exec(`CREATE TABLE conversations (id TEXT, title TEXT, user_id TEXT, project_id TEXT, created_at TEXT, updated_at TEXT);
        INSERT INTO conversations VALUES ('a', 'My-Chat', 'u', 'p', NULL, '2026-10-01 00:00:00');
        INSERT INTO conversations VALUES ('b', 'My Chat', 'u', 'p', NULL, '2026-10-01 00:00:00');
        INSERT INTO conversations VALUES ('c', 'My Chat', 'other', 'p', NULL, '2026-10-01 00:00:00');
        CREATE TABLE messages (id TEXT, conversation_id TEXT, parent_id TEXT, role TEXT, content TEXT, plain_text_content TEXT,
          note TEXT, note_color TEXT, created_at TEXT, children_ids TEXT, meta TEXT);
        INSERT INTO messages VALUES ('context', 'a', NULL, 'user', 'huge', NULL, NULL, NULL, NULL, '[]', '{"kind":"context_injection"}');
        INSERT INTO messages VALUES ('prompt', 'a', 'context', 'user', 'human', NULL, NULL, NULL, NULL, '[]', NULL);`)
      const source = readFileSync(new URL('../../localServer.ts', import.meta.url), 'utf8')
      const sql = source.match(/getToolConversationsPage: db.prepare\(`([\s\S]*?)`\)/)![1]
      const rows = db.prepare(sql).all({ userId: 'u', projectId: 'p', updatedAfter: '2026-10-01T00:00:00Z',
        updatedBefore: '2026-10-02T00:00:00Z', query: '%mychat%', normalizedQuery: '%mychat%', limit: 1, skip: 1 })
      expect(rows.map((row: any) => row.id)).toEqual(['b'])
      expect(rows[0]).not.toHaveProperty('user_id')
      expect(db.prepare(`SELECT COUNT(*) AS count FROM (${TOP_LEVEL_USER_MESSAGES_SQL})`).get('a').count).toBe(1)
    } finally { db.close() }
  })
})
