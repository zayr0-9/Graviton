import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRepo } from '../../persistence/messageRepo.js'
import { ProviderRouter } from '../providerRouter.js'
import { ToolLoopService } from '../toolLoopService.js'

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
  private readonly queuedOutputs: any[] = []

  enqueue(output: any): void {
    this.queuedOutputs.push(output)
  }

  async generate(_provider: string, _input: any): Promise<any> {
    if (this.queuedOutputs.length > 0) {
      return this.queuedOutputs.shift()
    }
    return { content: 'default' }
  }
}

describeIfSqlite('ToolLoopService', () => {
  let db: Database.Database
  let statements: any
  let messageRepo: MessageRepo

  beforeEach(() => {
    if (!BetterSqlite3Ctor) {
      throw new Error('better-sqlite3 is unavailable in this runtime')
    }

    db = new BetterSqlite3Ctor(':memory:')
    createSchema(db)
    statements = createStatements(db)

    const now = new Date().toISOString()
    statements.upsertConversation.run('c1', null, 'u1', 'Conversation', 'gpt-5.1-codex-mini', null, null, null, null, 'local', now, now)

    messageRepo = new MessageRepo({ db, statements })
  })

  afterEach(() => {
    db.close()
  })

  it('executes tool calls and continues to a second turn', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }],
      contentBlocks: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'README.md' } }],
    })
    providerRouter.enqueue({ content: 'Final answer.' })

    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => 'README body',
      maxTurns: 4,
    })

    const events: any[] = []
    const result = await service.run(
      {
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        conversationId: 'c1',
        assistantParentId: null,
        history: [],
        userContent: 'read and summarize',
      },
      event => events.push(event)
    )

    expect(result.turnsUsed).toBe(2)
    expect(result.finalAssistantMessage.content).toBe('Final answer.')

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const firstAssistant = messages.find((msg: any) => msg.role === 'assistant' && msg.content === '')
    const firstCalls = JSON.parse(firstAssistant.tool_calls || '[]') as any[]
    expect(firstCalls[0]?.status).toBe('complete')

    const firstBlocks = JSON.parse(firstAssistant.content_blocks || '[]') as any[]
    expect(firstBlocks.some((block: any) => block.type === 'tool_result' && block.tool_use_id === 'call-1')).toBe(true)

    expect(events.some((evt: any) => evt.type === 'tool_execution' && evt.status === 'started')).toBe(true)
    expect(events.some((evt: any) => evt.type === 'tool_execution' && evt.status === 'completed')).toBe(true)
    expect(events.some((evt: any) => evt.type === 'tool_loop' && evt.status === 'turn_completed' && evt.continued)).toBe(true)
  })

  it('continues loop when all tool executions fail', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'README.md' } }],
      contentBlocks: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'README.md' } }],
    })
    providerRouter.enqueue({ content: 'Recovered after tool failure.' })

    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => {
        throw new Error('execution denied')
      },
      maxTurns: 3,
    })

    const events: any[] = []
    const result = await service.run(
      {
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        conversationId: 'c1',
        assistantParentId: null,
        history: [],
        userContent: 'read and summarize',
      },
      event => events.push(event)
    )

    expect(result.turnsUsed).toBe(2)
    expect(result.finalAssistantMessage.content).toBe('Recovered after tool failure.')
    expect(events.some((evt: any) => evt.type === 'tool_execution' && evt.status === 'failed')).toBe(true)
    expect(events.some((evt: any) => evt.type === 'tool_loop' && evt.status === 'turn_completed' && evt.turn === 1 && evt.continued === true)).toBe(
      true
    )
  })
})
