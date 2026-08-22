import { describe, expect, it, vi } from 'vitest'
import type { HeadlessSubagentStreamRequest, HeadlessSubagentStreamEvent } from '../../../../../../shared/headlessApi.js'
import type { ProviderRouter } from '../providerRouter.js'
import type { SubagentRunRepo } from '../../persistence/subagentRunRepo.js'
import type { StreamingRunRepo } from '../../persistence/streamingRunRepo.js'
import { SubagentRunService, type ResolvedSubagentTools } from '../subagentRunService.js'

class FakeRunRepo {
  runs = new Map<string, any>()
  messages = new Map<string, any[]>()
  private seq = 0

  createRun(input: any): any {
    const seq = ++this.seq
    const id = input.id || `run-${seq}`
    const row = {
      id,
      conversation_id: input.conversationId,
      lineage_id: input.lineageId ?? null,
      parent_message_id: input.parentMessageId,
      tool_call_id: input.toolCallId ?? null,
      prompt: input.prompt,
      provider: input.provider ?? null,
      model_name: input.modelName ?? null,
      system_prompt: input.systemPrompt ?? null,
      status: input.status ?? 'running',
      final_response: null,
      error: null,
      turns_used: 0,
      tool_calls_used: 0,
      handle: input.handle ?? String(100000 + seq),
      attempt: 0,
      last_turn_at: null,
    }
    this.runs.set(id, row)
    this.messages.set(id, [])
    return { ...row, messages: [] }
  }

  appendMessage(runId: string, input: any): any {
    const list = this.messages.get(runId) || []
    const row = {
      id: input.id || `msg-${runId}-${list.length}`,
      run_id: runId,
      role: input.role,
      content: input.content ?? '',
      thinking_block: input.thinkingBlock ?? null,
      tool_calls: input.toolCalls ?? null,
      tool_call_id: input.toolCallId ?? null,
      content_blocks: input.contentBlocks ?? null,
      sequence: list.length,
      created_at: 'now',
    }
    list.push(row)
    this.messages.set(runId, list)
    return { ...row }
  }

  updateMessageToolState(runId: string, messageId: string, update: any): any | null {
    const list = this.messages.get(runId) || []
    const idx = list.findIndex(m => m.id === messageId)
    if (idx < 0) return null
    list[idx] = { ...list[idx], content_blocks: update.contentBlocks ?? null, tool_calls: update.toolCalls ?? null }
    return { ...list[idx] }
  }

  updateRun(runId: string, patch: any): any | null {
    const row = this.runs.get(runId)
    if (!row) return null
    if (patch.status != null) row.status = patch.status
    if (patch.finalResponse != null) row.final_response = patch.finalResponse
    if (patch.error !== undefined && patch.error !== null) row.error = patch.error
    if (patch.turnsUsed != null) row.turns_used = patch.turnsUsed
    if (patch.toolCallsUsed != null) row.tool_calls_used = patch.toolCallsUsed
    return { ...row }
  }

  getRunById(runId: string): any | null {
    const row = this.runs.get(runId)
    return row ? { ...row } : null
  }

  getMessages(runId: string): any[] {
    return (this.messages.get(runId) || []).map(m => ({ ...m }))
  }

  getRunByHandle(handle: string): any | null {
    const row = [...this.runs.values()].find(run => run.handle === handle)
    return row ? { ...row } : null
  }

  listByLineage(lineageId: string, status?: string): any[] {
    return [...this.runs.values()]
      .filter(run => run.lineage_id === lineageId && (!status || run.status === status))
      .map(run => ({ ...run }))
  }

  /** Compare-and-set reopen: only error|aborted -> running (bumps attempt). */
  reopenRun(runId: string): boolean {
    const row = this.runs.get(runId)
    if (!row) return false
    if (row.status !== 'error' && row.status !== 'aborted') return false
    row.status = 'running'
    row.error = null
    row.attempt = (row.attempt ?? 0) + 1
    return true
  }

  listRunning(): any[] {
    return [...this.runs.values()].filter(r => r.status === 'running').map(r => ({ ...r, messages: [] }))
  }
}

class FakeStreamingRunRepo {
  upsertCalls: any[] = []
  finishCalls: any[] = []

  upsert(input: any): string {
    const streamId = input.streamId || 'sub-stream-1'
    this.upsertCalls.push({ ...input, streamId })
    return streamId
  }

  finish(streamId: string, input: any): void {
    this.finishCalls.push({ streamId, ...input })
  }
}

class FakeProviderRouter {
  private readonly queued: any[] = []
  readonly calls: Array<{ provider: string; input: any }> = []

  enqueue(output: any): void {
    this.queued.push(output)
  }

  async generate(provider: string, input: any): Promise<any> {
    this.calls.push({ provider, input })
    if (this.queued.length > 0) {
      const next = await this.queued.shift()
      if (next instanceof Error) throw next
      return next
    }
    return { content: 'default' }
  }
}

const FIXED_TOOLS = [
  { name: 'read_file', description: '', inputSchema: {} },
  { name: 'bash', description: '', inputSchema: {} },
]

function makeResolver(tools = FIXED_TOOLS): (names: string[] | undefined) => ResolvedSubagentTools {
  return () => ({ tools, resolvedNames: tools.map(t => t.name), unknownNames: [] })
}

function baseRequest(overrides: Partial<HeadlessSubagentStreamRequest> = {}): HeadlessSubagentStreamRequest {
  return {
    conversationId: 'c1',
    parentMessageId: 'p1',
    toolCallId: 'call-1',
    streamId: 'parent-stream-1',
    lineageId: 'content-lineage-1',
    prompt: 'do the task',
    provider: 'openaichatgpt',
    modelName: 'gpt-5.6-sol',
    autoApprove: true,
    ...overrides,
  }
}

/**
 * Minimal RunSessionRegistry stand-in that records what each run publishes, so we
 * can assert live-stream events reach the session backing GET /api/streams/:id.
 */
class FakeRunSessionRegistry {
  sessions = new Map<string, { conversationId: string | null; published: any[]; terminal: boolean }>()

  create(streamId: string, conversationId: string | null) {
    if (!this.sessions.has(streamId)) this.sessions.set(streamId, { conversationId, published: [], terminal: false })
    return this.get(streamId)
  }

  get(streamId: string) {
    const record = this.sessions.get(streamId)
    if (!record) return undefined
    return {
      publish: (event: any) => {
        record.published.push(event)
        if (event.type === 'complete' || event.type === 'error') record.terminal = true
      },
    }
  }
}

function buildService(opts: {
  providerRouter: FakeProviderRouter
  runRepo: FakeRunRepo
  streamingRunRepo: FakeStreamingRunRepo
  toolExecutor?: (toolCall: any, ctx: any) => Promise<any>
  resolveToolsByName?: (names: string[] | undefined) => ResolvedSubagentTools
  generateCompactionSummary?: (input: any) => Promise<string>
  refreshProviderTokens?: (provider: string) => Promise<void> | void
  runSessions?: FakeRunSessionRegistry
}): SubagentRunService {
  return new SubagentRunService({
    runRepo: opts.runRepo as unknown as SubagentRunRepo,
    streamingRunRepo: opts.streamingRunRepo as unknown as StreamingRunRepo,
    providerRouter: opts.providerRouter as unknown as ProviderRouter,
    toolExecutor: opts.toolExecutor ?? (async () => 'tool output'),
    resolveToolsByName: opts.resolveToolsByName ?? makeResolver(),
    refreshProviderTokens: opts.refreshProviderTokens,
    compactionService: {
      generateCompactionSummary:
        opts.generateCompactionSummary ?? (async () => 'Following is summary of the session, you have to resume the work.\n\nsummary'),
    },
    runSessions: opts.runSessions as unknown as import('../runSessionRegistry.js').RunSessionRegistry | undefined,
  })
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('SubagentRunService', () => {
  it('completes a simple run and records transcript + streaming rows', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'the final answer' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest(), event => events.push(event), new AbortController().signal)

    const started = events.find(e => e.type === 'started') as any
    expect(started.subagentRunId).toBeTruthy()
    expect(started.streamId).toBe('sub-stream-1')
    expect(started.lineageId).toBe('content-lineage-1')
    expect(started.streamId).not.toBe(started.lineageId)
    expect(started.resolvedToolNames).toEqual(['read_file', 'bash'])

    const complete = events.find(e => e.type === 'complete') as any
    expect(complete.result).toBe('the final answer')
    expect(complete.lineageId).toBe('content-lineage-1')
    expect(complete.stats.turnsUsed).toBe(1)

    const runId = started.subagentRunId
    expect(runRepo.getRunById(runId)?.status).toBe('completed')
    expect(runRepo.getRunById(runId)?.lineage_id).toBe('content-lineage-1')
    expect(runRepo.getRunById(runId)?.final_response).toBe('the final answer')

    // First transcript row is the user prompt with the subagent_role marker.
    const messages = runRepo.getMessages(runId)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content_blocks[0].subagent_role).toBe('user_prompt')

    // Streaming run child row: subagent type, parent lineage, run-id metadata.
    expect(streamingRunRepo.upsertCalls[0]).toMatchObject({
      streamType: 'subagent',
      source: 'subagent',
      lineageId: 'content-lineage-1',
      parentStreamId: 'parent-stream-1',
      metadata: { subagent_run_id: runId },
    })
    expect(streamingRunRepo.finishCalls[0]).toMatchObject({ status: 'completed' })
  })

  it('returns the terminal result to a server-owned parent tool call', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'programmatic result' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })

    await expect(service.runForTool(baseRequest(), new AbortController().signal)).resolves.toBe('programmatic result')
    expect([...runRepo.runs.values()][0].status).toBe('completed')
  })

  it('rejects a server-owned parent tool call when the child ends in error', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: '' })
    providerRouter.enqueue({ content: '' })
    const service = buildService({
      providerRouter,
      runRepo: new FakeRunRepo(),
      streamingRunRepo: new FakeStreamingRunRepo(),
    })

    await expect(service.runForTool(baseRequest(), new AbortController().signal)).rejects.toThrow('empty response')
  })

  it('merges tool results and responses_output_items into the transcript', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'call-x', name: 'read_file', arguments: { path: 'a' } }],
      contentBlocks: [
        { type: 'tool_use', id: 'call-x', name: 'read_file', input: { path: 'a' } },
        { type: 'responses_output_items', items: [{ type: 'reasoning', id: 'r1' }] },
      ],
    })
    providerRouter.enqueue({ content: 'done' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo, toolExecutor: async () => 'file body' })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest(), event => events.push(event), new AbortController().signal)

    const runId = (events.find(e => e.type === 'started') as any).subagentRunId
    const messages = runRepo.getMessages(runId)
    const assistantWithTool = messages.find(
      m => m.role === 'assistant' && Array.isArray(m.content_blocks) && m.content_blocks.some((b: any) => b.type === 'tool_result')
    )
    expect(assistantWithTool).toBeTruthy()
    expect(assistantWithTool.content_blocks.some((b: any) => b.type === 'responses_output_items')).toBe(true)
    const complete = events.find(e => e.type === 'complete') as any
    expect(complete.stats.toolCallsUsed).toBe(1)
    expect(complete.stats.toolsExecuted).toEqual([{ name: 'read_file', success: true }])
  })

  it('denies mutating tools when autoApprove is false but runs read-only tools', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [
        { id: 'c-bash', name: 'bash', arguments: { command: 'rm -rf /' } },
        { id: 'c-read', name: 'read_file', arguments: { path: 'a' } },
      ],
    })
    providerRouter.enqueue({ content: 'finished' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const executed: string[] = []
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo,
      toolExecutor: async toolCall => {
        executed.push(toolCall.name)
        return 'ok'
      },
    })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest({ autoApprove: false }), event => events.push(event), new AbortController().signal)

    expect(executed).toEqual(['read_file']) // bash never reached the executor
    const failed = events.find(e => e.type === 'tool_execution' && (e as any).status === 'failed') as any
    expect(failed.toolName).toBe('bash')
    const complete = events.find(e => e.type === 'complete') as any
    expect(complete.result).toBe('finished')
    expect(complete.stats.toolsExecuted).toEqual([
      { name: 'bash', success: false },
      { name: 'read_file', success: true },
    ])
  })

  it('keeps mcp tools model-visible in plan mode (execution is gated in the tool loop)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'planned' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const toolsWithMcp = [
      { name: 'read_file', description: '', inputSchema: {} },
      { name: 'mcp__server__do', description: '', inputSchema: {} },
    ]
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo,
      resolveToolsByName: makeResolver(toolsWithMcp),
    })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest({ operationMode: 'plan' }), event => events.push(event), new AbortController().signal)

    // filterToolsForOperationMode is deliberately identity-valued: Agent-only schemas
    // stay visible so the model can ASK for an Agent-mode upgrade. For a subagent no
    // upgrade prompt exists (requestOperationModeUpgrade is unset), so ToolLoopService
    // falls through to assertToolAllowedForOperationMode, which throws on `mcp__*`.
    // See the plan-mode execution-gate test in operationModeSystemPrompt.test.ts.
    const started = events.find(e => e.type === 'started') as any
    expect(started.resolvedToolNames).toEqual(['read_file', 'mcp__server__do'])
    expect(providerRouter.calls[0].input.tools.map((t: any) => t.name)).toEqual(['read_file', 'mcp__server__do'])
  })

  it('marks the run errored when the provider stays empty', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: '' })
    providerRouter.enqueue({ content: '' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest(), event => events.push(event), new AbortController().signal)

    const runId = (events.find(e => e.type === 'started') as any).subagentRunId
    expect(runRepo.getRunById(runId)?.status).toBe('error')
    const errorEvent = events.find(e => e.type === 'error') as any
    expect(errorEvent.error).toContain('empty response')
    expect(streamingRunRepo.finishCalls[0]).toMatchObject({ status: 'error' })
  })

  it('retries a transient provider error and recovers (subagents opt into retryProviderError)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(new Error('request failed (429): too many requests'))
    providerRouter.enqueue({ content: 'recovered after retry' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest(), event => events.push(event), new AbortController().signal)

    // The transient 429 triggered one retry, surfaced as a provider_retry status.
    const retry = events.find(e => e.type === 'tool_loop' && (e as any).status === 'provider_retry') as any
    expect(retry).toBeTruthy()
    expect(retry.attempt).toBe(1)
    expect(providerRouter.calls).toHaveLength(2) // first (429) + retry (success)

    const complete = events.find(e => e.type === 'complete') as any
    expect(complete.result).toBe('recovered after retry')
    const runId = (events.find(e => e.type === 'started') as any).subagentRunId
    expect(runRepo.getRunById(runId)?.status).toBe('completed')
  })

  it('errors after exhausting provider retries (initial + 2)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(new Error('request failed (503): overloaded'))
    providerRouter.enqueue(new Error('request failed (503): overloaded'))
    providerRouter.enqueue(new Error('request failed (503): overloaded'))
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest(), event => events.push(event), new AbortController().signal)

    expect(providerRouter.calls).toHaveLength(3) // initial + 2 retries, then give up
    const runId = (events.find(e => e.type === 'started') as any).subagentRunId
    expect(runRepo.getRunById(runId)?.status).toBe('error')
    expect(events.filter(e => e.type === 'tool_loop' && (e as any).status === 'provider_retry')).toHaveLength(2)
  })

  it('does not retry a non-transient provider error', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue(new Error('request failed (400): bad request'))
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest(), event => events.push(event), new AbortController().signal)

    expect(providerRouter.calls).toHaveLength(1) // a 400 is not transient => no retry
    expect(events.some(e => e.type === 'tool_loop' && (e as any).status === 'provider_retry')).toBe(false)
    const runId = (events.find(e => e.type === 'started') as any).subagentRunId
    expect(runRepo.getRunById(runId)?.status).toBe('error')
  })

  it('marks the run aborted when the signal fires', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }],
    })
    providerRouter.enqueue({ content: 'unreached' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const controller = new AbortController()
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo,
      toolExecutor: async () => {
        controller.abort()
        return 'ok'
      },
    })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(baseRequest(), event => events.push(event), controller.signal)

    const runId = (events.find(e => e.type === 'started') as any).subagentRunId
    expect(runRepo.getRunById(runId)?.status).toBe('aborted')
    expect(streamingRunRepo.finishCalls[0]).toMatchObject({ status: 'aborted' })
    expect(providerRouter.calls).toHaveLength(1)
  })

  it('spawnDetached returns a handle immediately and completes in the background', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'async answer' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })

    const { handle, runId, streamId } = await service.spawnDetached(baseRequest())

    // Handle is returned and the run row exists synchronously (before the loop finishes).
    expect(handle).toMatch(/^\d{6}$/)
    expect(streamId).toBe('sub-stream-1')
    expect(runRepo.getRunById(runId)?.prompt).toBe('do the task')

    await waitFor(() => runRepo.getRunById(runId)?.status === 'completed')
    expect(runRepo.getRunById(runId)?.final_response).toBe('async answer')
    // Deregistered from the in-process active-run map once terminal.
    expect(service.isActive(handle!)).toBe(false)
  })

  it('waitForTerminal blocks without polling and supports multiple waiters', async () => {
    const providerRouter = new FakeProviderRouter()
    let releaseProvider!: (output: any) => void
    providerRouter.enqueue(
      new Promise(resolve => {
        releaseProvider = resolve
      })
    )
    const runRepo = new FakeRunRepo()
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo: new FakeStreamingRunRepo(),
    })

    const { handle } = await service.spawnDetached(baseRequest())
    const first = service.waitForTerminal(handle!)
    const second = service.waitForTerminal(handle!)
    let settled = false
    void first.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseProvider({ content: 'waited answer' })
    const [firstRun, secondRun] = await Promise.all([first, second])
    expect(firstRun).toMatchObject({ status: 'completed', final_response: 'waited answer' })
    expect(secondRun).toMatchObject({ status: 'completed', final_response: 'waited answer' })
    expect(service.isActive(handle!)).toBe(false)
  })

  it('aborting waitForTerminal does not cancel the detached child', async () => {
    const providerRouter = new FakeProviderRouter()
    let releaseProvider!: (output: any) => void
    providerRouter.enqueue(
      new Promise(resolve => {
        releaseProvider = resolve
      })
    )
    const runRepo = new FakeRunRepo()
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo: new FakeStreamingRunRepo(),
    })

    const { handle } = await service.spawnDetached(baseRequest())
    const waiterController = new AbortController()
    const waiting = service.waitForTerminal(handle!, waiterController.signal)
    waiterController.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.isActive(handle!)).toBe(true)

    releaseProvider({ content: 'still completed' })
    const terminal = await service.waitForTerminal(handle!)
    expect(terminal).toMatchObject({ status: 'completed', final_response: 'still completed' })
  })

  it('waitForTerminal returns terminal rows immediately and fails fast for a running orphan', async () => {
    const runRepo = new FakeRunRepo()
    const service = buildService({
      providerRouter: new FakeProviderRouter(),
      runRepo,
      streamingRunRepo: new FakeStreamingRunRepo(),
    })
    const completed = runRepo.createRun(baseRequest())
    runRepo.updateRun(completed.id, { status: 'completed', finalResponse: 'done' })
    await expect(service.waitForTerminal(completed.handle)).resolves.toMatchObject({ status: 'completed' })

    const orphan = runRepo.createRun(baseRequest())
    await expect(service.waitForTerminal(orphan.handle)).rejects.toThrow('no active runtime')
  })

  it('cancel(handle) aborts a detached run that is still executing', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] })
    providerRouter.enqueue({ content: 'unreached' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()

    let releaseTool!: () => void
    const toolGate = new Promise<void>(resolve => {
      releaseTool = resolve
    })
    let signalToolStarted!: () => void
    const toolStarted = new Promise<void>(resolve => {
      signalToolStarted = resolve
    })
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo,
      toolExecutor: async () => {
        signalToolStarted()
        await toolGate
        return 'ok'
      },
    })

    const { handle, runId } = await service.spawnDetached(baseRequest())
    await toolStarted // run is now mid-flight inside the tool
    expect(service.isActive(handle!)).toBe(true)
    expect(service.cancel(handle!)).toBe(true)
    releaseTool()

    await waitFor(() => runRepo.getRunById(runId)?.status === 'aborted')
    expect(streamingRunRepo.finishCalls.at(-1)).toMatchObject({ status: 'aborted' })
    expect(providerRouter.calls).toHaveLength(1) // second turn never ran
    expect(service.cancel(handle!)).toBe(false) // no longer active
  })

  it('compacts the transcript when usage crosses the threshold', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }],
      contextUsage: {
        provider: 'openai',
        inputTokens: 240_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningTokens: 0,
        totalTokens: 241_000,
        usedTokens: 241_000,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    providerRouter.enqueue({ content: 'after compaction' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    let compactionCalls = 0
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo,
      toolExecutor: async () => 'file body',
      generateCompactionSummary: async () => {
        compactionCalls++
        return 'Following is summary of the session, you have to resume the work.\n\nsummary'
      },
    })

    const events: HeadlessSubagentStreamEvent[] = []
    await service.run(
      baseRequest({ contextLength: 258_000, autoCompactionEnabled: true }),
      event => events.push(event),
      new AbortController().signal
    )

    expect(compactionCalls).toBe(1)
    expect(events.some(e => e.type === 'context_compaction' && (e as any).status === 'completed')).toBe(true)
    const runId = (events.find(e => e.type === 'started') as any).subagentRunId
    const systemRow = runRepo.getMessages(runId).find(m => m.role === 'system')
    expect(systemRow?.content).toContain('Following is summary of the session')
  })

  // Seed a terminated run + its transcript directly on the fake repo (as a crash
  // would have left it) so resume has something to rebuild from.
  function seedTerminatedRun(
    runRepo: FakeRunRepo,
    opts: { status?: 'error' | 'aborted'; danglingToolCall?: boolean } = {}
  ): string {
    const run = runRepo.createRun(baseRequest())
    const runId = run.id
    runRepo.appendMessage(runId, {
      role: 'user',
      content: 'do the task',
      contentBlocks: [{ type: 'text', content: 'do the task', subagent_role: 'user_prompt' }],
    })
    runRepo.appendMessage(runId, {
      role: 'assistant',
      content: 'starting work',
      toolCalls: opts.danglingToolCall ? [{ id: 'call-x', name: 'read_file', arguments: { path: 'a' } }] : null,
      contentBlocks: opts.danglingToolCall
        ? [
            { type: 'text', content: 'starting work' },
            { type: 'tool_use', id: 'call-x', name: 'read_file', input: { path: 'a' } },
          ]
        : [{ type: 'text', content: 'starting work' }],
    })
    runRepo.updateRun(runId, { status: opts.status ?? 'error', error: 'boom' })
    return runId
  }

  it('resumes a terminated run from its persisted transcript (rebuilt history, budget carried)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'resumed final answer' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo })
    const runId = seedTerminatedRun(runRepo)

    const outcome = await service.resumeDetached(runId, baseRequest())
    expect(outcome).not.toBeNull()
    expect(outcome!.runId).toBe(runId)
    await waitFor(() => runRepo.getRunById(runId)?.status === 'completed')

    // The provider was replayed with the REBUILT transcript (prompt + the prior
    // assistant turn), not a fresh single user turn. (The loop mutates this array
    // by reference as it appends new turns, so assert the rebuilt prefix, not the
    // post-run length.)
    const firstTurnHistory = providerRouter.calls[0].input.history
    expect(firstTurnHistory[0].role).toBe('user')
    expect(firstTurnHistory[0].content).toContain('do the task')
    expect(firstTurnHistory[1].role).toBe('assistant')
    expect(firstTurnHistory[1].content).toBe('starting work')

    // Budget carried: 1 prior assistant turn + 1 resumed turn = 2.
    const run = runRepo.getRunById(runId)
    expect(run?.status).toBe('completed')
    expect(run?.final_response).toBe('resumed final answer')
    expect(run?.turns_used).toBe(2)
    expect(run?.attempt).toBe(1) // reopenRun bumped it

    // A fresh streaming row was opened for the resumed attempt.
    const lastUpsert = streamingRunRepo.upsertCalls[streamingRunRepo.upsertCalls.length - 1]
    expect(lastUpsert.metadata).toMatchObject({ subagent_run_id: runId, resumed: true })
  })

  it('lets waitForTerminal attach while a resumed attempt is still preparing', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'resumed after preparation' })
    const runRepo = new FakeRunRepo()
    let signalRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => {
      signalRefreshStarted = resolve
    })
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve
    })
    const service = buildService({
      providerRouter,
      runRepo,
      streamingRunRepo: new FakeStreamingRunRepo(),
      refreshProviderTokens: async () => {
        signalRefreshStarted()
        await refreshGate
      },
    })
    const runId = seedTerminatedRun(runRepo)
    const handle = runRepo.getRunById(runId)!.handle

    const resuming = service.resumeDetached(runId, baseRequest())
    await refreshStarted
    expect(runRepo.getRunById(runId)?.status).toBe('running')
    expect(service.isActive(handle)).toBe(true)

    let settled = false
    const waiting = service.waitForTerminal(handle).then(run => {
      settled = true
      return run
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseRefresh()
    await resuming
    await expect(waiting).resolves.toMatchObject({ status: 'completed', final_response: 'resumed after preparation' })
  })

  it('settles resume waiters and restores error state when preparation fails', async () => {
    const runRepo = new FakeRunRepo()
    const service = buildService({
      providerRouter: new FakeProviderRouter(),
      runRepo,
      streamingRunRepo: new FakeStreamingRunRepo(),
      resolveToolsByName: () => {
        throw new Error('tool resolution failed')
      },
    })
    const runId = seedTerminatedRun(runRepo)
    const handle = runRepo.getRunById(runId)!.handle

    await expect(service.resumeDetached(runId, baseRequest())).rejects.toThrow('tool resolution failed')
    expect(service.isActive(handle)).toBe(false)
    await expect(service.waitForTerminal(handle)).resolves.toMatchObject({
      status: 'error',
      error: 'tool resolution failed',
    })
  })

  it('repairs a dangling tool_use before replay (synthesizes an is_error result, never re-executes)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'done after repair' })
    const runRepo = new FakeRunRepo()
    const toolExecutor = vi.fn(async () => 'should not run')
    const service = buildService({ providerRouter, runRepo, streamingRunRepo: new FakeStreamingRunRepo(), toolExecutor })
    const runId = seedTerminatedRun(runRepo, { danglingToolCall: true })

    await service.resumeDetached(runId, baseRequest())
    await waitFor(() => runRepo.getRunById(runId)?.status === 'completed')

    // The interrupted tool was NOT re-executed.
    expect(toolExecutor).not.toHaveBeenCalled()

    // The tail assistant now carries a synthetic is_error tool_result for call-x.
    const assistant = runRepo.getMessages(runId).find(m => m.role === 'assistant' && Array.isArray(m.tool_calls))
    const resultBlock = (assistant?.content_blocks as any[]).find(
      b => b.type === 'tool_result' && b.tool_use_id === 'call-x'
    )
    expect(resultBlock).toBeTruthy()
    expect(resultBlock.is_error).toBe(true)
    // And the provider's replayed history includes that repaired assistant.
    const replayed = providerRouter.calls[0].input.history.find((m: any) => Array.isArray(m.tool_calls))
    expect(replayed.content_blocks.some((b: any) => b.type === 'tool_result' && b.tool_use_id === 'call-x')).toBe(true)
  })

  it('does not resume a run that is not in a resumable state (reopen CAS fails)', async () => {
    const providerRouter = new FakeProviderRouter()
    const runRepo = new FakeRunRepo()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo: new FakeStreamingRunRepo() })
    const run = runRepo.createRun(baseRequest()) // status 'running'

    const outcome = await service.resumeDetached(run.id, baseRequest())
    expect(outcome).toBeNull()
    expect(providerRouter.calls).toHaveLength(0) // nothing driven
  })

  it('publishes stream events into the run session for live viewing', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'live answer' })
    const runRepo = new FakeRunRepo()
    const streamingRunRepo = new FakeStreamingRunRepo()
    const runSessions = new FakeRunSessionRegistry()
    const service = buildService({ providerRouter, runRepo, streamingRunRepo, runSessions })

    await service.run(baseRequest(), () => {}, new AbortController().signal)

    // A session was created for the child streamId and received started -> complete.
    const session = runSessions.sessions.get('sub-stream-1')
    expect(session).toBeTruthy()
    const types = session!.published.map(e => e.type)
    expect(types[0]).toBe('started')
    expect(types).toContain('complete')
    expect(session!.terminal).toBe(true)
  })

  it('reconciles orphaned running runs into a resumable error state at startup', async () => {
    const runRepo = new FakeRunRepo()
    const service = buildService({
      providerRouter: new FakeProviderRouter(),
      runRepo,
      streamingRunRepo: new FakeStreamingRunRepo(),
    })
    const orphanA = runRepo.createRun(baseRequest()) // running
    const orphanB = runRepo.createRun(baseRequest()) // running
    const done = runRepo.createRun(baseRequest())
    runRepo.updateRun(done.id, { status: 'completed' })

    const count = service.reconcileOrphanedRuns()
    expect(count).toBe(2)
    expect(runRepo.getRunById(orphanA.id)?.status).toBe('error')
    expect(runRepo.getRunById(orphanB.id)?.status).toBe('error')
    expect(runRepo.getRunById(done.id)?.status).toBe('completed')
    // Idempotent: a second sweep finds nothing still running.
    expect(service.reconcileOrphanedRuns()).toBe(0)
  })
})
