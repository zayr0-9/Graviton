import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRepo } from '../../persistence/messageRepo.js'
import type { MessageSink } from '../messageSink.js'
import { ProviderRouter } from '../providerRouter.js'
import { ProviderEmptyResponseError, ToolLoopService } from '../toolLoopService.js'

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
  readonly calls: Array<{ provider: string; input: any }> = []

  enqueue(output: any): void {
    this.queuedOutputs.push(output)
  }

  async generate(provider: string, input: any): Promise<any> {
    this.calls.push({ provider, input })
    if (this.queuedOutputs.length > 0) {
      const next = this.queuedOutputs.shift()
      if (next instanceof Error) throw next
      return next
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

  it('does not replay persisted history before the latest compaction summary', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'continued from summary' })
    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
    })

    await service.run({
      provider: 'openaichatgpt',
      modelName: 'gpt-5.4',
      conversationId: 'c1',
      assistantParentId: 'summary',
      history: [
        { id: 'old-user', role: 'user', content: 'old context' },
        { id: 'old-assistant', role: 'assistant', content: 'old answer' },
        {
          id: 'summary',
          role: 'system',
          note: '__auto_compaction_summary__',
          content: 'Following is summary of the session, you have to resume the work.\n\nsummary',
        },
        { id: 'new-user', role: 'user', content: 'new context' },
      ],
      userContent: 'continue',
    })

    expect(providerRouter.calls[0].input.history.map((message: any) => message.id)).toEqual(['summary', 'new-user'])
  })

  const retryRunInput = (robustness: any) => ({
    provider: 'zai',
    modelName: 'glm-4.6',
    conversationId: 'c1',
    assistantParentId: null,
    history: [{ role: 'user', content: 'hi' }],
    userContent: 'hi',
    robustness,
  })

  it('retries a transient provider error before continuing (provider_retry)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(new Error('request failed (503): overloaded'))
    providerRouter.enqueue({ content: 'recovered' })
    const service = new ToolLoopService({ messageRepo, providerRouter: providerRouter as unknown as ProviderRouter })

    const events: any[] = []
    const result = await service.run(
      retryRunInput({ retryProviderError: true, providerRetryBackoffMs: 1, maxProviderRetries: 2 }),
      (event: any) => events.push(event)
    )

    expect(providerRouter.calls).toHaveLength(2) // one failure + one successful retry
    const retry = events.find(e => e.type === 'tool_loop' && e.status === 'provider_retry')
    expect(retry).toMatchObject({ turn: 1, attempt: 1, maxAttempts: 2 })
    expect(result.finalAssistantMessage?.content).toContain('recovered')
    expect(result.turnsUsed).toBe(1) // the retry did NOT advance the turn counter
  })

  it('gives up after exhausting provider retries', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(new Error('request failed (503)'))
    providerRouter.enqueue(new Error('request failed (503)'))
    providerRouter.enqueue(new Error('request failed (503)'))
    const service = new ToolLoopService({ messageRepo, providerRouter: providerRouter as unknown as ProviderRouter })

    await expect(
      service.run(retryRunInput({ retryProviderError: true, providerRetryBackoffMs: 1, maxProviderRetries: 2 }), () => {})
    ).rejects.toThrow('request failed (503)')
    expect(providerRouter.calls).toHaveLength(3) // initial + 2 retries
  })

  it('does not retry a non-transient provider error', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(new Error('request failed (400): bad request'))
    const service = new ToolLoopService({ messageRepo, providerRouter: providerRouter as unknown as ProviderRouter })

    await expect(
      service.run(retryRunInput({ retryProviderError: true, providerRetryBackoffMs: 1, maxProviderRetries: 2 }), () => {})
    ).rejects.toThrow('request failed (400)')
    expect(providerRouter.calls).toHaveLength(1) // no retry for a 400
  })

  it('does not retry provider errors when retryProviderError is off (main-chat default)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(new Error('request failed (503)'))
    const service = new ToolLoopService({ messageRepo, providerRouter: providerRouter as unknown as ProviderRouter })

    await expect(service.run(retryRunInput(undefined), () => {})).rejects.toThrow('request failed (503)')
    expect(providerRouter.calls).toHaveLength(1) // opt-in only; no robustness => no retry
  })

  it('compacts an OpenAI tool loop before its next continuation request', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-compact', name: 'read_file', arguments: { path: 'README.md' } }],
      contentBlocks: [{ type: 'tool_use', id: 'call-compact', name: 'read_file', input: { path: 'README.md' } }],
      contextUsage: {
        provider: 'openai',
        inputTokens: 220_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningTokens: 0,
        totalTokens: 221_000,
        usedTokens: 221_000,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    providerRouter.enqueue({ content: 'Continued after compaction.' })

    let compactionCalls = 0
    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => 'README body',
      maxTurns: 4,
      compactBranch: async input => {
        compactionCalls++
        const summary = messageRepo.createMessage({
          conversationId: input.conversationId,
          parentId: input.parentMessageId,
          role: 'system',
          content: 'Compacted context',
          modelName: input.modelName,
          contentBlocks: [],
          note: '__auto_compaction_summary__',
        })
        return { message: summary }
      },
    })

    const events: any[] = []
    const result = await service.run(
      {
        provider: 'openaichatgpt',
        modelName: 'gpt-5.4',
        conversationId: 'c1',
        assistantParentId: null,
        history: [],
        userContent: 'read and summarize',
        autoCompactionEnabled: true,
        contextLength: 258_000,
      },
      event => events.push(event)
    )

    expect(result.finalAssistantMessage.content).toBe('Continued after compaction.')
    expect(compactionCalls).toBe(1)
    expect(providerRouter.calls[1].input.history).toHaveLength(1)
    expect(providerRouter.calls[1].input.history[0].note).toBe('__auto_compaction_summary__')
    expect(events.some(event => event.type === 'context_compaction' && event.status === 'completed')).toBe(true)
  })

  it('pauses before another provider call when mid-run compaction fails', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-fail', name: 'read_file', arguments: { path: 'README.md' } }],
      contextUsage: {
        provider: 'openai',
        inputTokens: 220_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningTokens: 0,
        totalTokens: 221_000,
        usedTokens: 221_000,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    })

    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => 'README body',
      compactBranch: async () => {
        throw new Error('summary provider unavailable')
      },
    })
    const events: any[] = []

    await expect(
      service.run(
        {
          provider: 'openai',
          modelName: 'gpt-5.4',
          conversationId: 'c1',
          assistantParentId: null,
          history: [],
          userContent: 'read it',
          autoCompactionEnabled: true,
          contextLength: 258_000,
        },
        event => events.push(event)
      )
    ).rejects.toThrow('continuation paused')

    expect(providerRouter.calls).toHaveLength(1)
    expect(events.some(event => event.type === 'context_compaction' && event.status === 'failed')).toBe(true)
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

    expect(providerRouter.calls).toHaveLength(2)
    expect(providerRouter.calls[1].input.railwayTurn?.previousResponseId).toBeUndefined()
    expect(providerRouter.calls[1].input.history.some((entry: any) => entry.role === 'assistant')).toBe(true)
    expect(providerRouter.calls[1].input.history.some((entry: any) => entry.role === 'tool' && entry.tool_call_id === 'call-1')).toBe(true)
  })

  it('persists a user-facing assistant response when OpenAI fails after retries', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(
      new Error(
        'ChatGPT backend request failed (429): {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":1782168563}}'
      )
    )

    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      maxTurns: 3,
    })

    const events: any[] = []
    await expect(
      service.run(
        {
          provider: 'openaichatgpt',
          modelName: 'gpt-5.4-mini',
          conversationId: 'c1',
          assistantParentId: null,
          history: [],
          userContent: 'hello',
        },
        event => events.push(event)
      )
    ).rejects.toMatchObject({ name: 'ProviderErrorAssistantResponse' })

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const assistant = messages.find((msg: any) => msg.role === 'assistant')
    expect(assistant.content).toContain('I could not complete the OpenAI ChatGPT (gpt-5.4-mini) response after retrying')
    expect(assistant.content).toContain('The usage limit has been reached')
    expect(assistant.content).toContain('HTTP status: 429')
    expect(assistant.content).toContain('Error type: usage_limit_reached')
    expect(events.some((evt: any) => evt.type === 'chunk' && evt.part === 'text' && evt.delta.includes('usage limit'))).toBe(true)
    expect(events.some((evt: any) => evt.type === 'assistant_message_persisted' && evt.message.id === assistant.id)).toBe(true)
    expect(events.some((evt: any) => evt.type === 'error')).toBe(false)
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


describeIfSqlite('ToolLoopService model-facing tool result sanitization', () => {
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

  it('persists compact view_image metadata while sending only typed modelContent to continuation history', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-image', name: 'view_image', arguments: { path: '/tmp/image.png' } }],
      contentBlocks: [{ type: 'tool_use', id: 'call-image', name: 'view_image', input: { path: '/tmp/image.png' } }],
    })
    providerRouter.enqueue({ content: 'I can see the image.' })

    const dataUrl = `data:image/png;base64,${'a'.repeat(2048)}`
    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => ({
        success: true,
        displayContent: '[Image: image/png, 1.5 KB, detail=high]',
        persistedContent: {
          success: true,
          path: '/tmp/image.png',
          mimeType: 'image/png',
          sizeBytes: 1536,
          detail: 'high',
          summary: '[Image: image/png, 1.5 KB, detail=high]',
        },
        modelContent: [{ type: 'input_image', image_url: dataUrl, detail: 'high' }],
      }),
      maxTurns: 4,
    })

    await service.run({
      provider: 'openaichatgpt',
      modelName: 'gpt-5.1-codex-mini',
      conversationId: 'c1',
      assistantParentId: null,
      history: [],
      userContent: 'inspect the image',
    })

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const firstAssistant = messages.find((msg: any) => msg.role === 'assistant' && msg.content === '')
    const firstBlocks = JSON.parse(firstAssistant.content_blocks || '[]') as any[]
    const persistedToolResult = firstBlocks.find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'call-image')
    expect(persistedToolResult.content).toContain('/tmp/image.png')
    expect(persistedToolResult.content).not.toContain('base64')
    expect(persistedToolResult.content).not.toContain(dataUrl)

    const continuationToolMessage = providerRouter.calls[1].input.history.find(
      (entry: any) => entry.role === 'tool' && entry.tool_call_id === 'call-image'
    )
    expect(JSON.parse(continuationToolMessage.content)).toEqual([
      { type: 'input_image', image_url: dataUrl, detail: 'high' },
    ])
  })

  it('keeps raw plan_md display content persisted while sending only modelContent to continuation history', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-plan', name: 'plan_md', arguments: { action: 'display', name: 'sample-plan' } }],
      contentBlocks: [{ type: 'tool_use', id: 'call-plan', name: 'plan_md', input: { action: 'display', name: 'sample-plan' } }],
    })
    providerRouter.enqueue({ content: 'Plan displayed above' })

    const rawToolResult = {
      displayed: true,
      exists: true,
      name: 'sample-plan',
      content: '# Long plan\n\nThis should be rendered but not sent back to the model.',
      modelContent: 'Plan "sample-plan" was displayed to the user in the chat view. Do not repeat the plan unless the user asks.',
    }

    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => rawToolResult,
      maxTurns: 4,
    })

    await service.run({
      provider: 'openaichatgpt',
      modelName: 'gpt-5.1-codex-mini',
      conversationId: 'c1',
      assistantParentId: null,
      history: [],
      userContent: 'display the plan',
    })

    const messages = statements.getMessagesByConversationId.all('c1') as any[]
    const firstAssistant = messages.find((msg: any) => msg.role === 'assistant' && msg.content === '')
    const firstBlocks = JSON.parse(firstAssistant.content_blocks || '[]') as any[]
    const persistedToolResult = firstBlocks.find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'call-plan')
    expect(JSON.parse(persistedToolResult.content).content).toContain('# Long plan')

    expect(providerRouter.calls).toHaveLength(2)
    const continuationToolMessage = providerRouter.calls[1].input.history.find(
      (entry: any) => entry.role === 'tool' && entry.tool_call_id === 'call-plan'
    )
    expect(continuationToolMessage.content).toBe(
      'Plan "sample-plan" was displayed to the user in the chat view. Do not repeat the plan unless the user asks.'
    )
    expect(continuationToolMessage.content).not.toContain('# Long plan')
  })
})

describeIfSqlite('ToolLoopService plan mode runtime block list', () => {
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

  it('allows bash and powershell execution in plan mode before invoking the executor', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [
        { id: 'call-bash', name: 'bash', arguments: { command: 'pwd', description: 'print working directory' } },
        { id: 'call-powershell', name: 'powershell', arguments: { command: 'Get-Location', description: 'print working directory' } },
      ],
    })
    providerRouter.enqueue({ content: 'done' })

    const executedToolNames: string[] = []
    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async toolCall => {
        executedToolNames.push(toolCall.name)
        return `${toolCall.name}-ok`
      },
      maxTurns: 3,
    })

    await service.run(
      {
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        conversationId: 'c1',
        assistantParentId: null,
        history: [],
        userContent: 'inspect',
        operationMode: 'plan',
      },
      () => {}
    )

    expect(executedToolNames).toEqual(['bash', 'powershell'])
  })

  it('requests an Agent-mode upgrade before executing a mutating Plan-mode tool', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: '', toolCalls: [{ id: 'call-edit', name: 'edit_file', arguments: { path: 'README.md' } }] })
    providerRouter.enqueue({ content: 'done' })

    const requested: string[] = []
    const executedModes: string[] = []
    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async (_toolCall, context) => {
        executedModes.push(context.operationMode || '')
        return 'edited'
      },
      maxTurns: 3,
    })

    await service.run(
      {
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        conversationId: 'c1',
        assistantParentId: null,
        history: [],
        userContent: 'edit',
        systemPrompt: 'Custom Plan baseline\n\n## Plan Response Style',
        agentSystemPrompt: 'Custom Agent baseline',
        operationMode: 'plan',
        requestOperationModeUpgrade: async toolCall => {
          requested.push(toolCall.id)
          return true
        },
      },
      () => {}
    )

    expect(requested).toEqual(['call-edit'])
    expect(executedModes).toEqual(['execute'])
    expect(providerRouter.calls[0].input.systemPrompt).toContain('Custom Plan baseline')
    expect(providerRouter.calls[1].input.systemPrompt).toBe('Custom Agent baseline')
    expect(providerRouter.calls[1].input.systemPrompt).not.toContain('## Plan Response Style')
  })

  it('blocks mutating tools in plan mode before invoking the executor', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-edit', name: 'edit_file', arguments: { path: 'README.md' } }],
    })
    providerRouter.enqueue({ content: 'recovered' })

    let executorCalled = false
    const service = new ToolLoopService({
      messageRepo,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => {
        executorCalled = true
        return 'should-not-run'
      },
      maxTurns: 3,
    })

    const events: any[] = []
    await service.run(
      {
        provider: 'openaichatgpt',
        modelName: 'gpt-5.1-codex-mini',
        conversationId: 'c1',
        assistantParentId: null,
        history: [],
        userContent: 'edit',
        operationMode: 'plan',
      },
      event => events.push(event)
    )

    expect(executorCalled).toBe(false)
    expect(events.some((event: any) => event.type === 'tool_execution' && event.status === 'failed')).toBe(true)
  })

})

// These exercise the loop control flow (signal, robustness) without SQLite by
// injecting an in-memory MessageSink, so they run in every environment.
class FakeSink implements MessageSink {
  readonly persisted: any[] = []
  private seq = 0

  persistAssistantMessage(draft: any): any {
    const message = {
      id: `m${++this.seq}`,
      role: 'assistant',
      content: draft.content ?? '',
      content_blocks: JSON.stringify(draft.contentBlocks ?? null),
      tool_calls: JSON.stringify(draft.toolCalls ?? null),
      parent_id: draft.parentId ?? null,
      conversation_id: draft.conversationId,
      ...(draft.contextUsage ? { context_usage: draft.contextUsage } : {}),
    }
    this.persisted.push(message)
    return message
  }

  updateAssistantToolState(messageId: string, update: any): any | null {
    const message = this.persisted.find(m => m.id === messageId)
    if (!message) return null
    message.content_blocks = JSON.stringify(update.contentBlocks ?? null)
    message.tool_calls = JSON.stringify(update.toolCalls ?? null)
    return message
  }
}

const baseRunInput = {
  provider: 'openaichatgpt',
  modelName: 'gpt-5.6-sol',
  conversationId: 'c1',
  assistantParentId: null,
  history: [] as any[],
  userContent: 'do the task',
}

describe('ToolLoopService signal + robustness (in-memory sink)', () => {
  it('does not silently self-upgrade out of plan mode when no upgrade handler is wired', async () => {
    // Regression: requiresAgentMode() is true for ANYTHING outside the plan allow
    // list, but assertToolAllowedForOperationMode() throws only for the blocked list
    // and `mcp__*`. html_renderer is in neither, so with no requestOperationModeUpgrade
    // handler (the subagent case, and the main loop without a decisionBroker) the guard
    // used to fall through: the tool ran AND activeOperationMode became 'execute' for
    // the REST of the run. Turn 2's edit_file proves the mode did not stick.
    //
    // Lives in the in-memory-sink suite on purpose: the plan-mode gate has nothing to
    // do with SQLite, and describeIfSqlite is skipped wherever better-sqlite3 is
    // unavailable — which is exactly where a regression would go unnoticed.
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-html', name: 'html_renderer', arguments: { html: '<p>hi</p>' } }],
    })
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-edit', name: 'edit_file', arguments: { path: 'README.md' } }],
    })
    providerRouter.enqueue({ content: 'recovered' })

    const executed: string[] = []
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async toolCall => {
        executed.push(toolCall.name)
        return 'should-not-run'
      },
      maxTurns: 4,
    })

    const events: any[] = []
    await service.run(
      // requestOperationModeUpgrade deliberately omitted.
      { ...baseRunInput, userContent: 'render then edit', operationMode: 'plan' },
      event => events.push(event)
    )

    expect(executed).toEqual([])
    const failures = events.filter((event: any) => event.type === 'tool_execution' && event.status === 'failed')
    expect(failures.map((event: any) => event.toolName)).toEqual(['html_renderer', 'edit_file'])
  })

  it('forwards the abort signal to the provider request', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'done' })
    const controller = new AbortController()
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
    })

    await service.run({ ...baseRunInput, signal: controller.signal }, () => {})

    expect(providerRouter.calls[0].input.signal).toBe(controller.signal)
  })

  it('stops before the next turn when aborted during tool execution', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a' } }],
    })
    providerRouter.enqueue({ content: 'should never run' })
    const controller = new AbortController()
    const sink = new FakeSink()
    const service = new ToolLoopService({
      sink,
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => {
        controller.abort()
        return 'tool output'
      },
    })

    await expect(service.run({ ...baseRunInput, signal: controller.signal }, () => {})).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(providerRouter.calls).toHaveLength(1)
  })

  it('propagates an abort thrown by a tool without recording a failed tool result', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a' } }],
    })
    const controller = new AbortController()
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => {
        controller.abort()
        const abortError = new Error('aborted')
        abortError.name = 'AbortError'
        throw abortError
      },
    })

    const events: any[] = []
    await expect(
      service.run({ ...baseRunInput, signal: controller.signal }, event => events.push(event))
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(events.some(event => event.type === 'tool_execution' && event.status === 'failed')).toBe(false)
  })

  it('retries once on an empty turn and recovers', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: '' })
    providerRouter.enqueue({ content: 'recovered answer' })
    const sink = new FakeSink()
    const service = new ToolLoopService({
      sink,
      providerRouter: providerRouter as unknown as ProviderRouter,
    })

    const events: any[] = []
    const result = await service.run(
      { ...baseRunInput, robustness: { retryEmptyTurn: true, emptyTurnRetryDelayMs: 1 } },
      event => events.push(event)
    )

    expect(providerRouter.calls).toHaveLength(2)
    expect(result.finalAssistantMessage.content).toBe('recovered answer')
    expect(sink.persisted).toHaveLength(1)
    expect(events.some(event => event.type === 'tool_loop' && event.status === 'empty_turn_retry')).toBe(true)
  })

  it('throws ProviderEmptyResponseError when a no-tool run stays empty after retry', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: '' })
    providerRouter.enqueue({ content: '   ' })
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
    })

    await expect(
      service.run({ ...baseRunInput, robustness: { retryEmptyTurn: true, emptyTurnRetryDelayMs: 1 } }, () => {})
    ).rejects.toBeInstanceOf(ProviderEmptyResponseError)
    expect(providerRouter.calls).toHaveLength(2)
  })

  it('runs a tool-free finalization turn when tools ran but no answer was produced', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a' } }],
    })
    providerRouter.enqueue({ content: '' })
    providerRouter.enqueue({ content: 'final summary' })
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => 'tool output',
      maxTurns: 5,
    })

    const events: any[] = []
    const result = await service.run(
      { ...baseRunInput, robustness: { finalizeOnSilentToolEnd: true } },
      event => events.push(event)
    )

    expect(result.finalAssistantMessage.content).toBe('final summary')
    expect(result.anyToolsExecuted).toBe(true)
    expect(providerRouter.calls[2].input.tools).toBeUndefined()
    expect(events.some(event => event.type === 'tool_loop' && event.status === 'finalization_turn')).toBe(true)
  })

  it('finalizes instead of throwing when max turns are exhausted with tool activity', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a' } }],
    })
    providerRouter.enqueue({ content: 'wrapped up' })
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => 'tool output',
      maxTurns: 1,
    })

    const result = await service.run(
      { ...baseRunInput, robustness: { finalizeOnSilentToolEnd: true } },
      () => {}
    )

    expect(result.finalAssistantMessage.content).toBe('wrapped up')
  })

  it('still throws on max turns when finalization is disabled', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a' } }],
    })
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => 'tool output',
      maxTurns: 1,
    })

    await expect(service.run({ ...baseRunInput }, () => {})).rejects.toThrow('reached max turns')
  })

  it('clamps the per-run maxTurns override', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'a', name: 'read_file', arguments: {} }],
    })
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'b', name: 'read_file', arguments: {} }],
    })
    providerRouter.enqueue({ content: 'unreached' })
    const service = new ToolLoopService({
      sink: new FakeSink(),
      providerRouter: providerRouter as unknown as ProviderRouter,
      executeTool: async () => 'tool output',
      maxTurns: 400,
    })

    const events: any[] = []
    await expect(
      service.run({ ...baseRunInput, maxTurns: 2 }, event => events.push(event))
    ).rejects.toThrow('reached max turns (2)')
    expect(providerRouter.calls).toHaveLength(2)
    expect(events.some(event => event.type === 'tool_loop' && event.status === 'max_turns_reached' && event.maxTurns === 2)).toBe(true)
  })
})
