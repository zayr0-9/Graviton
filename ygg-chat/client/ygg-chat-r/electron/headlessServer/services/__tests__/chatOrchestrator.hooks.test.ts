import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookEventName, HookRunRequest, HookRunResult } from '../../../hooks/hookTypes.js'
import type { ToolExecutionContext, ToolExecutor } from '../toolLoopService.js'
import { ChatOrchestrator, createChatPausingExecutor } from '../chatOrchestrator.js'
import { createChatHookSession } from '../chatHookService.js'
import { DecisionBroker } from '../decisionBroker.js'

// ── DB-free unit tests for the executor interleave (createChatPausingExecutor) ──

function makeHookSession(byEvent: Partial<Record<HookEventName, HookRunResult>>) {
  const events: HookEventName[] = []
  const runHook = async (req: HookRunRequest): Promise<HookRunResult> => {
    events.push(req.event)
    return byEvent[req.event] ?? { matched: false, hookCount: 0 }
  }
  const session = createChatHookSession({
    conversationRepo: { listMessages: () => [], getMessageById: () => null },
    runHook,
    conversationId: 'c1',
    cwd: '/root',
    provider: 'lmstudio',
    model: 'qwen',
    operation: 'send',
    streamId: 's1',
    project: null,
    localApiBase: null,
  })
  return { session, events }
}

const ctx: ToolExecutionContext = { conversationId: 'c1', messageId: 'a1', streamId: 's1', rootPath: '/root', operationMode: 'execute' }

function autoApproveBroker(): DecisionBroker {
  const broker = new DecisionBroker()
  broker.initSession('s1', { autoApproveAll: true })
  return broker
}

describe('createChatPausingExecutor (hook interleave)', () => {
  it('PreToolUse rewrites args (base sees them) and PostToolUse fires on success', async () => {
    const receivedArgs: any[] = []
    const base: ToolExecutor = async toolCall => {
      receivedArgs.push(toolCall.arguments)
      return 'result-value'
    }
    const { session, events } = makeHookSession({ PreToolUse: { matched: true, hookCount: 1, updatedInput: { path: 'rewritten' } } })
    const exec = createChatPausingExecutor({ base, broker: autoApproveBroker(), streamId: 's1', emit: () => {}, hookSession: session })

    const result = await exec({ id: 't1', name: 'read_file', arguments: { path: 'orig' } } as any, ctx)
    expect(result).toBe('result-value')
    expect(receivedArgs).toEqual([{ path: 'rewritten' }])
    expect(events).toEqual(['PreToolUse', 'PostToolUse'])
  })

  it('PreToolUse deny throws with the reason, never calls base, and fires PostToolUseFailure', async () => {
    let baseCalled = false
    const base: ToolExecutor = async () => {
      baseCalled = true
      return 'nope'
    }
    const { session, events } = makeHookSession({
      PreToolUse: { matched: true, hookCount: 1, permissionDecision: 'deny', permissionDecisionReason: 'blocked by policy' },
    })
    const exec = createChatPausingExecutor({ base, broker: autoApproveBroker(), streamId: 's1', emit: () => {}, hookSession: session })

    await expect(exec({ id: 't1', name: 'bash', arguments: {} } as any, ctx)).rejects.toThrow('blocked by policy')
    expect(baseCalled).toBe(false)
    expect(events).toEqual(['PreToolUse', 'PostToolUseFailure'])
  })

  it('a base execution error fires PostToolUseFailure then re-throws', async () => {
    const base: ToolExecutor = async () => {
      throw new Error('kaboom')
    }
    const { session, events } = makeHookSession({})
    const exec = createChatPausingExecutor({ base, broker: autoApproveBroker(), streamId: 's1', emit: () => {}, hookSession: session })

    await expect(exec({ id: 't1', name: 'bash', arguments: {} } as any, ctx)).rejects.toThrow('kaboom')
    expect(events).toEqual(['PreToolUse', 'PostToolUseFailure'])
  })

  it('an ABORT escapes unwrapped and does NOT fire PostToolUseFailure', async () => {
    const controller = new AbortController()
    const base: ToolExecutor = async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const { session, events } = makeHookSession({})
    const exec = createChatPausingExecutor({ base, broker: autoApproveBroker(), streamId: 's1', emit: () => {}, hookSession: session })

    await expect(exec({ id: 't1', name: 'bash', arguments: {} } as any, { ...ctx, signal: controller.signal })).rejects.toThrow('aborted')
    expect(events).toEqual(['PreToolUse']) // no PostToolUseFailure on cancel
  })

  it('emitted permission prompt shows the REWRITTEN args (not auto-approved case)', async () => {
    const broker = new DecisionBroker()
    broker.initSession('s1', { autoApproveAll: false })
    const emitted: any[] = []
    const base: ToolExecutor = async () => 'ok'
    const { session } = makeHookSession({ PreToolUse: { matched: true, hookCount: 1, updatedInput: { path: 'rewritten' } } })
    const exec = createChatPausingExecutor({ base, broker, streamId: 's1', emit: e => emitted.push(e), hookSession: session })

    const run = exec({ id: 't1', name: 'read_file', arguments: { path: 'orig' } } as any, ctx)
    // The executor runs PreToolUse (async) then pauses awaiting the permission decision.
    // Wait until the pending decision is registered, then resolve it deterministically.
    for (let i = 0; i < 200 && !broker.hasPending('s1', 't1'); i++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(broker.hasPending('s1', 't1')).toBe(true)
    broker.resolve('s1', 't1', 'allow_once')
    await run
    const prompt = emitted.find(e => e.type === 'permission_required')
    expect(prompt.toolInput).toEqual({ path: 'rewritten' })
    expect(prompt.toolCallId).toBe('t1')
  })

  it('allow_always releases concurrent permission waiters and upgrades their execution context', async () => {
    const broker = new DecisionBroker()
    broker.initSession('s1', { autoApproveAll: false })
    const executed: Array<{ id: string; autoApprove: boolean | undefined }> = []
    const base: ToolExecutor = async (toolCall, context) => {
      executed.push({ id: toolCall.id, autoApprove: context.autoApprove })
      return toolCall.id
    }
    const emitted: any[] = []
    const exec = createChatPausingExecutor({ base, broker, streamId: 's1', emit: event => emitted.push(event) })

    const first = exec({ id: 'batch:1', name: 'read_file', arguments: { path: 'a' } } as any, { ...ctx, autoApprove: false })
    const second = exec({ id: 'batch:2', name: 'glob', arguments: { pattern: '*' } } as any, { ...ctx, autoApprove: false })

    expect(broker.hasPending('s1', 'batch:1')).toBe(true)
    expect(broker.hasPending('s1', 'batch:2')).toBe(true)
    expect(broker.resolve('s1', 'batch:2', 'allow_always')).toBe(true)

    await expect(Promise.all([first, second])).resolves.toEqual(['batch:1', 'batch:2'])
    expect(executed).toEqual([
      { id: 'batch:1', autoApprove: true },
      { id: 'batch:2', autoApprove: true },
    ])
    expect(emitted.filter(event => event.type === 'permission_required')).toHaveLength(2)
    expect(broker.isAutoApproveAll('s1')).toBe(true)
  })

  it('plan_md clarify (hooks active) fires PreToolUse + PostToolUse around the clarify decision, honoring updatedInput', async () => {
    const broker = autoApproveBroker()
    const emitted: any[] = []
    let baseCalled = false
    const base: ToolExecutor = async () => {
      baseCalled = true
      return 'nope'
    }
    // PreToolUse rewrites the clarify questions.
    const { session, events } = makeHookSession({ PreToolUse: { matched: true, hookCount: 1, updatedInput: { action: 'clarify', questions: ['rewritten-q'] } } })
    const exec = createChatPausingExecutor({ base, broker, streamId: 's1', emit: e => emitted.push(e), hookSession: session })

    const run = exec({ id: 't1', name: 'plan_md', arguments: { action: 'clarify', questions: ['orig-q'] } } as any, ctx)
    for (let i = 0; i < 200 && !broker.hasPending('s1', 't1'); i++) await new Promise(r => setTimeout(r, 0))
    expect(broker.hasPending('s1', 't1')).toBe(true)
    broker.resolve('s1', 't1', { answers: ['a1'], cancelled: false })
    const result = await run

    expect(baseCalled).toBe(false) // clarify never executes the base tool
    expect(events).toEqual(['PreToolUse', 'PostToolUse']) // both fire around clarify (renderer parity)
    const clarify = emitted.find(e => e.type === 'clarify_required')
    expect(clarify.questions).toEqual(['rewritten-q']) // Pre updatedInput reached the clarify prompt
    expect(result).toMatchObject({ clarified: true, cancelled: false })
  })

  it('a PreToolUse deny on a clarify call blocks it (no clarify_required) and fires PostToolUseFailure', async () => {
    const emitted: any[] = []
    const { session, events } = makeHookSession({
      PreToolUse: { matched: true, hookCount: 1, permissionDecision: 'deny', permissionDecisionReason: 'no clarify' },
    })
    const exec = createChatPausingExecutor({ base: async () => 'x', broker: autoApproveBroker(), streamId: 's1', emit: e => emitted.push(e), hookSession: session })

    await expect(exec({ id: 't1', name: 'plan_md', arguments: { action: 'clarify', questions: ['q'] } } as any, ctx)).rejects.toThrow('no clarify')
    expect(emitted.find(e => e.type === 'clarify_required')).toBeUndefined()
    expect(events).toEqual(['PreToolUse', 'PostToolUseFailure'])
  })

  it('no hookSession => exact Phase-2 path (auto-approve runs base, no hook events)', async () => {
    let baseCalled = false
    const base: ToolExecutor = async () => {
      baseCalled = true
      return 'ok'
    }
    const emitted: any[] = []
    const exec = createChatPausingExecutor({ base, broker: autoApproveBroker(), streamId: 's1', emit: e => emitted.push(e) })
    const result = await exec({ id: 't1', name: 'read_file', arguments: {} } as any, ctx)
    expect(result).toBe('ok')
    expect(baseCalled).toBe(true)
    expect(emitted).toEqual([]) // auto-approve => no permission_required prompt
  })
})

// ── Integration: UserPromptSubmit + hooks-off gate via the full runMessage (sqlite) ──

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
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, user_id TEXT, context TEXT, system_prompt TEXT, storage_mode TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT, title TEXT, model_name TEXT, system_prompt TEXT, conversation_context TEXT, research_note TEXT, cwd TEXT, storage_mode TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, children_ids TEXT, role TEXT, content TEXT, plain_text_content TEXT, thinking_block TEXT, tool_calls TEXT, tool_call_id TEXT, model_name TEXT, note TEXT, note_color TEXT, ex_agent_session_id TEXT, ex_agent_type TEXT, content_blocks TEXT, created_at TEXT);
  `)
}

function createStatements(db: Database.Database): any {
  return {
    upsertConversation: db.prepare(`INSERT INTO conversations (id, project_id, user_id, title, model_name, system_prompt, conversation_context, research_note, cwd, storage_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getConversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    upsertMessage: db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, children_ids, role, content, plain_text_content, thinking_block, tool_calls, tool_call_id, model_name, note, note_color, ex_agent_session_id, ex_agent_type, content_blocks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, plain_text_content = excluded.plain_text_content, thinking_block = excluded.thinking_block, tool_calls = excluded.tool_calls, content_blocks = excluded.content_blocks`),
    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getMessagesByConversationId: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'),
    upsertStreamingRun: { run: () => {} },
    getStreamingRunById: { get: () => null },
    updateStreamingRun: { run: () => {} },
  }
}

class FakeProviderRouter {
  private readonly queued: any[] = []
  readonly calls: any[] = []
  enqueue(output: any): void {
    this.queued.push(output)
  }
  async generate(_provider: string, input: any): Promise<any> {
    this.calls.push(input)
    return this.queued.length > 0 ? this.queued.shift() : { content: 'default' }
  }
}

describeIfSqlite('ChatOrchestrator chat hooks (integration)', () => {
  let db: Database.Database
  let statements: any
  let providerRouter: FakeProviderRouter

  beforeEach(() => {
    db = new BetterSqlite3Ctor!(':memory:')
    createSchema(db)
    statements = createStatements(db)
    const now = new Date().toISOString()
    statements.upsertConversation.run('c1', null, 'u1', 'Conversation', 'qwen', null, null, null, null, 'local', now, now)
    providerRouter = new FakeProviderRouter()
  })
  afterEach(() => db.close())

  it('UserPromptSubmit rewrites the prompt (persist + inference) and folds context into turn 1', async () => {
    providerRouter.enqueue({ content: 'ok' })
    const runner = vi.fn(async (req: HookRunRequest): Promise<HookRunResult> =>
      req.event === 'UserPromptSubmit'
        ? { matched: true, hookCount: 1, updatedPrompt: 'REWRITTEN', additionalContext: 'ups-ctx' }
        : { matched: false, hookCount: 0 }
    )
    const orchestrator = new ChatOrchestrator({
      db,
      statements,
      providerRouter: providerRouter as any,
      toolExecutor: (async () => 'x') as any,
      decisionBroker: new DecisionBroker(),
      hookRunner: runner,
    })

    await orchestrator.runMessage(
      { operation: 'send', conversationId: 'c1', parentId: null, content: 'original', provider: 'lmstudio', modelName: 'qwen', hooksEnabled: true, streamId: 's1' },
      () => {}
    )

    const user = (statements.getMessagesByConversationId.all('c1') as any[]).find(m => m.role === 'user')
    expect(user.content).toBe('REWRITTEN')
    expect(providerRouter.calls[0].userContent).toBe('REWRITTEN')
    expect(providerRouter.calls[0].systemPrompt).toContain('[Hook context]\nups-ctx')
  })

  it('regression: hooksEnabled unset => the hook runner is never called and content is untouched', async () => {
    providerRouter.enqueue({ content: 'ok' })
    const runner = vi.fn(async (): Promise<HookRunResult> => ({ matched: true, hookCount: 1, updatedPrompt: 'NOPE' }))
    const orchestrator = new ChatOrchestrator({
      db,
      statements,
      providerRouter: providerRouter as any,
      toolExecutor: (async () => 'x') as any,
      decisionBroker: new DecisionBroker(),
      hookRunner: runner,
    })

    await orchestrator.runMessage(
      { operation: 'send', conversationId: 'c1', parentId: null, content: 'original', provider: 'lmstudio', modelName: 'qwen', streamId: 's1' },
      () => {}
    )

    expect(runner).not.toHaveBeenCalled()
    const user = (statements.getMessagesByConversationId.all('c1') as any[]).find(m => m.role === 'user')
    expect(user.content).toBe('original')
  })
})
