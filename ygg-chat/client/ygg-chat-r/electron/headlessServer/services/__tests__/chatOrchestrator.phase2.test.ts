import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRepo } from '../../persistence/messageRepo.js'
import { ChatOrchestrator } from '../chatOrchestrator.js'

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
  private readonly queuedOutputs: any[] = []

  enqueue(output: any): void {
    this.queuedOutputs.push(output)
  }

  async generate(_provider: string, input: any): Promise<any> {
    this.calls.push(input)
    if (this.queuedOutputs.length > 0) {
      return this.queuedOutputs.shift()
    }
    return { content: `assistant:${input.userContent}` }
  }
}

describeIfSqlite('ChatOrchestrator continuation semantics', () => {
  let db: Database.Database
  let statements: any
  let messageRepo: MessageRepo
  let providerRouter: FakeProviderRouter
  let orchestrator: ChatOrchestrator

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
    providerRouter = new FakeProviderRouter()
    orchestrator = new ChatOrchestrator({ db, statements, providerRouter: providerRouter as any })
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  it('send creates user then assistant', async () => {
    const events: any[] = []
    await orchestrator.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'hello',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      event => events.push(event)
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const user = messages.find(m => m.role === 'user')
    const assistant = messages.find(m => m.role === 'assistant')

    expect(user).toBeTruthy()
    expect(assistant).toBeTruthy()
    expect(assistant.parent_id).toBe(user.id)
    expect(events.some(evt => evt.type === 'user_message_persisted')).toBe(true)
    expect(events[events.length - 1].type).toBe('complete')
  })

  it('repeat regenerates assistant without creating new user', async () => {
    const user = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: null,
      role: 'user',
      content: 'original question',
      modelName: 'gpt-5.1-codex-mini',
    })
    const originalAssistant = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: user.id,
      role: 'assistant',
      content: 'old answer',
      modelName: 'gpt-5.1-codex-mini',
    })

    await orchestrator.runMessage(
      {
        operation: 'repeat',
        conversationId: 'c1',
        parentId: null,
        messageId: originalAssistant.id,
        content: '',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const users = messages.filter(m => m.role === 'user')
    const assistants = messages.filter(m => m.role === 'assistant')
    const newestAssistant = assistants[assistants.length - 1]

    expect(users).toHaveLength(1)
    expect(assistants.length).toBe(2)
    expect(newestAssistant.parent_id).toBe(user.id)
    expect(providerRouter.calls[0].userContent).toBe('original question')
  })

  it('branch creates child user off message and assistant under that branch', async () => {
    const rootUser = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: null,
      role: 'user',
      content: 'root',
      modelName: 'gpt-5.1-codex-mini',
    })

    await orchestrator.runMessage(
      {
        operation: 'branch',
        conversationId: 'c1',
        parentId: null,
        messageId: rootUser.id,
        content: 'new branch prompt',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const branchedUser = messages.find(m => m.role === 'user' && m.content === 'new branch prompt')
    const branchedAssistant = messages.find(m => m.role === 'assistant' && m.parent_id === branchedUser.id)

    expect(branchedUser.parent_id).toBe(rootUser.id)
    expect(branchedAssistant).toBeTruthy()
  })

  it('edit-branch creates sibling user and assistant', async () => {
    const originalUser = messageRepo.createMessage({
      conversationId: 'c1',
      parentId: null,
      role: 'user',
      content: 'old user text',
      modelName: 'gpt-5.1-codex-mini',
    })

    await orchestrator.runMessage(
      {
        operation: 'edit-branch',
        conversationId: 'c1',
        parentId: null,
        messageId: originalUser.id,
        content: 'edited user text',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const editedUser = messages.find(m => m.role === 'user' && m.content === 'edited user text')
    const editedAssistant = messages.find(m => m.role === 'assistant' && m.parent_id === editedUser.id)

    expect(editedUser.parent_id).toBeNull()
    expect(editedAssistant).toBeTruthy()
  })

  it('runs tool loop server-side: assistant tool call -> tool result -> continued assistant', async () => {
    providerRouter.enqueue({
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
      contentBlocks: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'read_file',
          input: { path: 'README.md' },
        },
      ],
    })

    providerRouter.enqueue({
      content: 'Final answer after tool.',
      contentBlocks: [{ type: 'text', content: 'Final answer after tool.' }],
    })

    const orchestratorWithTools = new ChatOrchestrator({
      db,
      statements,
      providerRouter: providerRouter as any,
      toolExecutor: async toolCall => {
        if (toolCall.name === 'read_file') {
          return 'README file contents'
        }
        throw new Error(`Unexpected tool: ${toolCall.name}`)
      },
    })

    const events: any[] = []
    await orchestratorWithTools.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'Read README and summarize',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        tools: [
          {
            name: 'read_file',
            description: 'Read file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          },
        ],
      },
      event => events.push(event)
    )

    expect(providerRouter.calls).toHaveLength(2)
    expect(providerRouter.calls[0].tools?.[0]?.name).toBe('read_file')
    expect(providerRouter.calls[1].history.some((entry: any) => entry.role === 'tool' && entry.tool_call_id === 'call-1')).toBe(
      true
    )

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const assistantMessages = messages.filter(m => m.role === 'assistant')
    expect(assistantMessages.length).toBe(2)

    const firstAssistant = assistantMessages[0]
    const firstAssistantBlocks = JSON.parse(firstAssistant.content_blocks || '[]') as any[]
    expect(firstAssistantBlocks.some(block => block.type === 'tool_result' && block.tool_use_id === 'call-1')).toBe(true)

    const firstAssistantCalls = JSON.parse(firstAssistant.tool_calls || '[]') as any[]
    expect(firstAssistantCalls[0]?.status).toBe('complete')
    expect(firstAssistantCalls[0]?.result).toContain('README file contents')

    const finalAssistant = assistantMessages[1]
    expect(finalAssistant.content).toBe('Final answer after tool.')

    expect(events.some(evt => evt.type === 'chunk' && evt.part === 'tool_call')).toBe(true)
    expect(events.some(evt => evt.type === 'chunk' && evt.part === 'tool_result')).toBe(true)
    expect(events.some(evt => evt.type === 'tool_execution' && evt.status === 'started' && evt.toolCallId === 'call-1')).toBe(
      true
    )
    expect(
      events.some(evt => evt.type === 'tool_execution' && evt.status === 'completed' && evt.toolCallId === 'call-1')
    ).toBe(true)

    const turnEvents = events.filter(evt => evt.type === 'tool_loop')
    expect(turnEvents.some((evt: any) => evt.status === 'turn_started' && evt.turn === 1)).toBe(true)
    expect(turnEvents.some((evt: any) => evt.status === 'turn_completed' && evt.turn === 1 && evt.continued === true)).toBe(
      true
    )
    expect(turnEvents.some((evt: any) => evt.status === 'turn_completed' && evt.turn === 2 && evt.continued === false)).toBe(
      true
    )

    expect(events[events.length - 1].type).toBe('complete')
  })

  it('uses server default tools provider when request omits tools', async () => {
    providerRouter.enqueue({ content: 'No tools needed.' })

    const orchestratorWithDefaultTools = new ChatOrchestrator({
      db,
      statements,
      providerRouter: providerRouter as any,
      defaultToolsProvider: () => [
        {
          name: 'read_file',
          description: 'Read file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    })

    await orchestratorWithDefaultTools.runMessage(
      {
        operation: 'send',
        conversationId: 'c1',
        parentId: null,
        content: 'hello with fallback tools',
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
      },
      () => {}
    )

    const latestCall = providerRouter.calls[providerRouter.calls.length - 1]
    expect(latestCall.tools?.[0]?.name).toBe('read_file')
  })
})
