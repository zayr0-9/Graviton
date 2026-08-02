import { describe, expect, it } from 'vitest'
import type { HeadlessSubagentStreamRequest, HeadlessSubagentStreamEvent } from '../../contracts/headlessApi.js'
import type { ProviderRouter } from '../providerRouter.js'
import type { SubagentRunRepo } from '../../persistence/subagentRunRepo.js'
import type { StreamingRunRepo } from '../../persistence/streamingRunRepo.js'
import { SubagentRunService, type ResolvedSubagentTools } from '../subagentRunService.js'

class FakeRunRepo {
  runs = new Map<string, any>()
  messages = new Map<string, any[]>()
  private seq = 0

  createRun(input: any): any {
    const id = input.id || `run-${++this.seq}`
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
      const next = this.queued.shift()
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

function buildService(opts: {
  providerRouter: FakeProviderRouter
  runRepo: FakeRunRepo
  streamingRunRepo: FakeStreamingRunRepo
  toolExecutor?: (toolCall: any, ctx: any) => Promise<any>
  resolveToolsByName?: (names: string[] | undefined) => ResolvedSubagentTools
  generateCompactionSummary?: (input: any) => Promise<string>
}): SubagentRunService {
  return new SubagentRunService({
    runRepo: opts.runRepo as unknown as SubagentRunRepo,
    streamingRunRepo: opts.streamingRunRepo as unknown as StreamingRunRepo,
    providerRouter: opts.providerRouter as unknown as ProviderRouter,
    toolExecutor: opts.toolExecutor ?? (async () => 'tool output'),
    resolveToolsByName: opts.resolveToolsByName ?? makeResolver(),
    compactionService: {
      generateCompactionSummary:
        opts.generateCompactionSummary ?? (async () => 'Following is summary of the session, you have to resume the work.\n\nsummary'),
    },
  })
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

  it('filters mcp tools out of the tool set in plan mode', async () => {
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

    const started = events.find(e => e.type === 'started') as any
    expect(started.resolvedToolNames).toEqual(['read_file'])
    expect(providerRouter.calls[0].input.tools.map((t: any) => t.name)).toEqual(['read_file'])
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
})
