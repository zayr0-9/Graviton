import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRepo } from '../../persistence/messageRepo.js'
import { AUTO_COMPACTION_NOTE, AUTO_COMPACTION_SUMMARY_RESUME_LINE, CompactionService } from '../compactionService.js'

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

class FakeProviderRouter {
  public calls: any[] = []
  public nextOutput: any = { content: '## Objective\nKeep going.' }

  async generate(provider: string, input: any): Promise<any> {
    this.calls.push({ provider, input })
    if (this.nextOutput instanceof Error) throw this.nextOutput
    return this.nextOutput
  }
}

describeIfSqlite('CompactionService', () => {
  let db: Database.Database
  let statements: any
  let messageRepo: MessageRepo
  let providerRouter: FakeProviderRouter
  let service: CompactionService

  beforeEach(() => {
    if (!BetterSqlite3Ctor) throw new Error('better-sqlite3 is unavailable in this runtime')

    db = new BetterSqlite3Ctor(':memory:')
    createSchema(db)
    statements = createStatements(db)

    const now = new Date().toISOString()
    statements.upsertConversation.run('c1', null, 'u1', 'Conversation', 'gpt-test', null, null, null, null, 'local', now, now)

    messageRepo = new MessageRepo({ db, statements })
    providerRouter = new FakeProviderRouter()
    service = new CompactionService({ db, statements, providerRouter: providerRouter as any })
  })

  afterEach(() => {
    db?.close()
  })

  it('generates and persists a system compaction message under the requested parent', async () => {
    const user = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user', content: 'Build mobile slash menu' })
    const assistant = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: user.id,
      role: 'assistant',
      content: 'Implemented the first part',
    })

    const result = await service.compactBranch({
      conversationId: 'c1',
      parentMessageId: assistant.id,
      messages: [user, assistant],
      provider: 'openaichatgpt',
      modelName: 'gpt-test',
      userId: 'u1',
    })

    expect(providerRouter.calls).toHaveLength(1)
    expect(providerRouter.calls[0].provider).toBe('openaichatgpt')
    expect(providerRouter.calls[0].input.tools).toEqual([])
    expect(providerRouter.calls[0].input.userContent).toContain('Conversation history:')
    expect(providerRouter.calls[0].input.userContent).toContain('USER: Build mobile slash menu')

    expect(result.message.role).toBe('system')
    expect(result.message.note).toBe(AUTO_COMPACTION_NOTE)
    expect(result.message.parent_id).toBe(assistant.id)
    expect(result.message.content).toContain(AUTO_COMPACTION_SUMMARY_RESUME_LINE)
    expect(result.message.content).toContain('## Objective')

    const reloadedParent = statements.getMessageById.get(assistant.id) as any
    expect(JSON.parse(reloadedParent.children_ids)).toContain(result.message.id)
  })

  it('includes completed read and subagent tool interactions in the summary prompt and persisted context', async () => {
    const summary = await service.generateCompactionSummary({
      messages: [
        {
          role: 'user',
          content: 'Investigate the compaction bug',
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: JSON.stringify([
            { id: 'call-read', name: 'read_file', arguments: { path: '/workspace/src/chat.ts' } },
            { id: 'call-subagent', name: 'subagent', arguments: { prompt: 'Trace the tool history flow' } },
          ]),
          content_blocks: JSON.stringify([
            {
              type: 'tool_result',
              tool_use_id: 'call-read',
              content: 'export const compactHistory = true',
              is_error: false,
            },
          ]),
        },
        {
          role: 'tool',
          tool_call_id: 'call-subagent',
          content: 'Scout found that tool messages were filtered before summarization.',
        },
      ],
      provider: 'openaichatgpt',
      modelName: 'gpt-test',
    })

    const prompt = providerRouter.calls[0].input.userContent
    expect(prompt).toContain('Recent tool interactions')
    expect(prompt).toContain('read_file success')
    expect(prompt).toContain('/workspace/src/chat.ts')
    expect(prompt).toContain('export const compactHistory = true')
    expect(prompt).toContain('subagent success')
    expect(prompt).toContain('Trace the tool history flow')
    expect(prompt).toContain('Scout found that tool messages were filtered before summarization.')

    expect(summary).toContain('Recent tool interactions')
    expect(summary).toContain('export const compactHistory = true')
    expect(summary).toContain('Scout found that tool messages were filtered before summarization.')
  })

  it('extracts tool calls from tool_use content blocks when tool_calls metadata is absent', async () => {
    await service.generateCompactionSummary({
      messages: [
        {
          role: 'assistant',
          content: '',
          content_blocks: [
            { type: 'tool_use', id: 'call-glob', name: 'glob', input: { pattern: '**/*.ts' } },
            { type: 'tool_result', tool_use_id: 'call-glob', content: ['src/a.ts', 'src/b.ts'], is_error: false },
          ],
        },
      ],
      provider: 'openaichatgpt',
      modelName: 'gpt-test',
    })

    const prompt = providerRouter.calls[0].input.userContent
    expect(prompt).toContain('glob success')
    expect(prompt).toContain('**/*.ts')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('src/b.ts')
  })

  it('rejects empty provider summaries', async () => {
    providerRouter.nextOutput = { content: '   ' }
    const user = messageRepo.createMessage({ conversationId: 'c1', parentId: null, role: 'user', content: 'hello' })
    const assistant = messageRepo.createMessage({ conversationId: 'c1', parentId: user.id, role: 'assistant', content: 'world' })

    await expect(
      service.compactBranch({
        conversationId: 'c1',
        parentMessageId: assistant.id,
        messages: [user, assistant],
        provider: 'openaichatgpt',
        modelName: 'gpt-test',
      })
    ).rejects.toThrow('Compaction returned empty summary')
  })
})
