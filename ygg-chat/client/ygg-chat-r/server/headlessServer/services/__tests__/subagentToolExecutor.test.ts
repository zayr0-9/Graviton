import { describe, expect, it, vi } from 'vitest'
import type { HeadlessSubagentStreamRequest } from '../../../../../../shared/headlessApi.js'
import type { SubagentRunRow, SubagentRunStatus } from '../../persistence/subagentRunRepo.js'
import {
  createSubagentDispatchExecutor,
  createSubagentManagerExecutor,
  type SubagentManagerRunner,
} from '../subagentToolExecutor.js'

const context = (overrides: Record<string, any> = {}) => ({
  conversationId: 'conversation-1',
  messageId: 'assistant-tool-message',
  streamId: 'parent-stream',
  lineageId: 'content-lineage-1',
  rootPath: '/workspace',
  operationMode: 'execute' as const,
  provider: 'openaichatgpt',
  modelName: 'gpt-5.6-sol',
  autoApprove: true,
  subagentReasoningEffort: 'high' as const,
  signal: new AbortController().signal,
  ...overrides,
})

describe('createSubagentDispatchExecutor', () => {
  it('delegates ordinary tools to the leaf executor', async () => {
    const leafExecutor = vi.fn(async () => 'leaf result')
    const runForTool = vi.fn()
    const execute = createSubagentDispatchExecutor({ leafExecutor, subagentRunner: { runForTool } })

    await expect(execute({ id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } }, context())).resolves.toBe(
      'leaf result'
    )
    expect(leafExecutor).toHaveBeenCalledOnce()
    expect(runForTool).not.toHaveBeenCalled()
  })

  it('runs subagent in-process with parent correlation and explicit orchestrator tools', async () => {
    const leafExecutor = vi.fn()
    const runForTool = vi.fn(async () => 'scout report')
    const execute = createSubagentDispatchExecutor({ leafExecutor, subagentRunner: { runForTool } })

    const result = await execute(
      {
        id: 'sub-1',
        name: 'subagent',
        arguments: {
          prompt: 'Scout the stream code',
          systemPrompt: 'Report facts only',
          temperature: 0.2,
          orchestratorMode: true,
          tools: ['read_file', 'ripgrep', 'subagent'],
          inheritAutoApprove: true,
        },
      },
      context({ operationMode: 'plan', subagentSystemPrompt: 'Custom Subagent baseline' })
    )

    expect(result).toBe('scout report')
    expect(leafExecutor).not.toHaveBeenCalled()
    const childSystemPrompt = runForTool.mock.calls[0][0].systemPrompt
    expect(childSystemPrompt).toBe('Custom Subagent baseline\n\nReport facts only')
    expect(childSystemPrompt).not.toContain('Agent Prompt: Subagent mode')
    expect(runForTool).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        parentMessageId: 'assistant-tool-message',
        toolCallId: 'sub-1',
        streamId: 'parent-stream',
        lineageId: 'content-lineage-1',
        prompt: 'Scout the stream code',
        systemPrompt: expect.stringContaining('Report facts only'),
        provider: 'openaichatgpt',
        modelName: 'gpt-5.6-sol',
        tools: ['read_file', 'ripgrep', 'multi_call'],
        temperature: 0.2,
        reasoningEffort: 'high',
        operationMode: 'plan',
        autoApprove: true,
        rootPath: '/workspace',
      }),
      expect.any(AbortSignal)
    )
  })

  it('uses server defaults when orchestrator mode is off and honors inherited approval denial', async () => {
    const runForTool = vi.fn(async () => 'done')
    const execute = createSubagentDispatchExecutor({ leafExecutor: vi.fn(), subagentRunner: { runForTool } })

    await execute(
      {
        id: 'sub-2',
        name: 'subagent',
        arguments: { prompt: 'Scout', orchestratorMode: false, tools: ['bash'], inheritAutoApprove: false },
      },
      context()
    )

    const request = runForTool.mock.calls[0][0]
    expect(request.tools).toBeUndefined()
    expect(request.autoApprove).toBe(false)
  })

  it('falls OpenRouter parents back to the local subagent provider', async () => {
    const runForTool = vi.fn(async () => 'done')
    const execute = createSubagentDispatchExecutor({ leafExecutor: vi.fn(), subagentRunner: { runForTool } })

    await execute(
      { id: 'sub-3', name: 'subagent', arguments: { prompt: 'Scout' } },
      context({ provider: 'openrouter', modelName: 'cloud-model' })
    )

    expect(runForTool.mock.calls[0][0]).toMatchObject({ provider: 'openaichatgpt', modelName: 'gpt-5.6-sol' })
  })

  it('rejects missing prompts before starting a child run', async () => {
    const runForTool = vi.fn()
    const execute = createSubagentDispatchExecutor({ leafExecutor: vi.fn(), subagentRunner: { runForTool } })

    await expect(execute({ id: 'sub-4', name: 'subagent', arguments: {} }, context())).rejects.toThrow(
      'Subagent requires a prompt'
    )
    expect(runForTool).not.toHaveBeenCalled()
  })
})

/**
 * In-memory SubagentManagerRunner. Stores runs keyed by handle and tracks which
 * ones are "live" so isActive/cancel behave like the real engine. lineage_id /
 * conversation_id come from the built request (which the executor derives from
 * the ToolExecutionContext), so ownership scoping is exercised end to end.
 */
class FakeManagerRunner implements SubagentManagerRunner {
  runs = new Map<string, SubagentRunRow>()
  private live = new Set<string>()
  private seq = 0
  cancelCalls: string[] = []
  resumeCalls: Array<{ runId: string; request: HeadlessSubagentStreamRequest }> = []
  waitCalls: Array<{ handle: string; signal?: AbortSignal }> = []
  private waiters = new Map<string, Array<(run: SubagentRunRow) => void>>()

  private makeRun(request: HeadlessSubagentStreamRequest, status: SubagentRunStatus, finalResponse: string | null): SubagentRunRow {
    const seq = ++this.seq
    const handle = String(100000 + seq)
    const run: SubagentRunRow = {
      id: `run-${seq}`,
      conversation_id: request.conversationId,
      lineage_id: request.lineageId ?? null,
      parent_message_id: request.parentMessageId,
      tool_call_id: request.toolCallId ?? null,
      prompt: request.prompt,
      provider: request.provider ?? null,
      model_name: request.modelName ?? null,
      system_prompt: request.systemPrompt ?? null,
      status,
      final_response: finalResponse,
      error: status === 'error' || status === 'aborted' ? 'boom' : null,
      turns_used: 1,
      tool_calls_used: 0,
      handle,
      attempt: 0,
      last_turn_at: null,
      created_at: 'now',
      updated_at: 'now',
    }
    this.runs.set(handle, run)
    return run
  }

  async spawnDetached(request: HeadlessSubagentStreamRequest) {
    const run = this.makeRun(request, 'running', null)
    this.live.add(run.handle!)
    return { handle: run.handle, runId: run.id, streamId: `stream-${run.id}` }
  }

  async spawnBlocking(request: HeadlessSubagentStreamRequest, _signal: AbortSignal) {
    const run = this.makeRun(request, 'completed', `result for: ${request.prompt}`)
    return {
      handle: run.handle,
      runId: run.id,
      streamId: `stream-${run.id}`,
      status: run.status as SubagentRunStatus,
      result: run.final_response ?? '',
      error: null as string | null,
    }
  }

  async resumeDetached(runId: string, request: HeadlessSubagentStreamRequest) {
    this.resumeCalls.push({ runId, request })
    const run = [...this.runs.values()].find(r => r.id === runId)
    // Mirror the real reopenRun CAS: only error|aborted runs reopen.
    if (!run || (run.status !== 'error' && run.status !== 'aborted')) return null
    run.status = 'running'
    this.live.add(run.handle!)
    return { handle: run.handle, runId: run.id, streamId: `stream-${run.id}-resumed` }
  }

  cancel(handle: string): boolean {
    this.cancelCalls.push(handle)
    if (!this.live.has(handle)) return false
    this.live.delete(handle)
    const run = this.runs.get(handle)
    if (run) run.status = 'aborted'
    return true
  }

  isActive(handle: string): boolean {
    return this.live.has(handle)
  }

  async waitForTerminal(handle: string, signal?: AbortSignal): Promise<SubagentRunRow | null> {
    this.waitCalls.push({ handle, signal })
    const run = this.runs.get(handle)
    if (!run || run.status !== 'running') return run ?? null
    if (signal?.aborted) {
      const error = new Error('Subagent wait aborted')
      error.name = 'AbortError'
      throw error
    }
    return new Promise<SubagentRunRow>((resolve, reject) => {
      const onAbort = (): void => {
        signal?.removeEventListener('abort', onAbort)
        const error = new Error('Subagent wait aborted')
        error.name = 'AbortError'
        reject(error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const settle = (terminal: SubagentRunRow): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(terminal)
      }
      const waiters = this.waiters.get(handle) ?? []
      waiters.push(settle)
      this.waiters.set(handle, waiters)
    })
  }

  getRunByHandle(handle: string): SubagentRunRow | null {
    return this.runs.get(handle) ?? null
  }

  listByLineage(lineageId: string, status?: SubagentRunStatus): SubagentRunRow[] {
    return [...this.runs.values()].filter(run => run.lineage_id === lineageId && (!status || run.status === status))
  }

  /** Force a stored run into a terminal state (for status/resumable assertions). */
  setStatus(handle: string, status: SubagentRunStatus): void {
    const run = this.runs.get(handle)
    if (run) {
      run.status = status
      if (status === 'completed') run.final_response = 'finished result'
      if (status === 'error' || status === 'aborted') run.error = 'boom'
      this.live.delete(handle)
      const waiters = this.waiters.get(handle) ?? []
      this.waiters.delete(handle)
      for (const settle of waiters) settle(run)
    }
  }
}

const spawnCall = (args: Record<string, any>) => ({ id: `mgr-${Math.random()}`, name: 'subagent_manager', arguments: args })

describe('createSubagentManagerExecutor', () => {
  it('delegates non-manager tools to the leaf executor', async () => {
    const leafExecutor = vi.fn(async () => 'leaf result')
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor, runner })

    await expect(execute({ id: 'r1', name: 'read_file', arguments: {} }, context())).resolves.toBe('leaf result')
    expect(leafExecutor).toHaveBeenCalledOnce()
  })

  it('spawns a background run and returns a handle immediately', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })

    const result: any = await execute(spawnCall({ action: 'spawn', prompt: 'scout the code' }), context())
    expect(result.action).toBe('spawn')
    expect(result.blocking).toBe(false)
    expect(result.status).toBe('running')
    expect(result.handle).toMatch(/^\d{6}$/)
    // The stored run inherited this branch's lineage from the context.
    expect(runner.getRunByHandle(result.handle)?.lineage_id).toBe('content-lineage-1')
  })

  it('spawns a blocking run and returns its result inline', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })

    const result: any = await execute(spawnCall({ action: 'spawn', prompt: 'do it', blocking: true }), context())
    expect(result.blocking).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.result).toBe('result for: do it')
  })

  it('requires a prompt to spawn', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    await expect(execute(spawnCall({ action: 'spawn' }), context())).rejects.toThrow('Subagent requires a prompt')
  })

  it('rejects an unknown action', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    await expect(execute(spawnCall({ action: 'frobnicate' }), context())).rejects.toThrow('unknown action')
  })

  it('isolates one branch from a parallel branch in the same conversation', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })

    // Branch A and branch B share a conversation but have distinct lineages.
    const branchA = context({ lineageId: 'lin-A', conversationId: 'shared-convo' })
    const branchB = context({ lineageId: 'lin-B', conversationId: 'shared-convo' })

    const aSpawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'A work' }), branchA)
    const bSpawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'B work' }), branchB)

    // Each branch's list sees ONLY its own run.
    const aList: any = await execute(spawnCall({ action: 'list' }), branchA)
    const bList: any = await execute(spawnCall({ action: 'list' }), branchB)
    expect(aList.subagents.map((s: any) => s.handle)).toEqual([aSpawn.handle])
    expect(bList.subagents.map((s: any) => s.handle)).toEqual([bSpawn.handle])

    // Branch A cannot inspect branch B's handle.
    const crossStatus: any = await execute(spawnCall({ action: 'status', handle: bSpawn.handle }), branchA)
    expect(crossStatus.found).toBe(false)

    // Branch A cannot cancel branch B's run — the runner is never even asked.
    const crossCancel: any = await execute(spawnCall({ action: 'cancel', handle: bSpawn.handle }), branchA)
    expect(crossCancel.cancelled).toBe(false)
    expect(runner.cancelCalls).not.toContain(bSpawn.handle)
    // ...and B's run is still live.
    expect(runner.isActive(bSpawn.handle)).toBe(true)
  })

  it('status returns an owned run with a live flag', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const spawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context())

    const status: any = await execute(spawnCall({ action: 'status', handle: spawn.handle }), context())
    expect(status.found).toBe(true)
    expect(status.subagent.handle).toBe(spawn.handle)
    expect(status.subagent.live).toBe(true)
    expect(status.subagent.resumable).toBe(false)
  })

  it('waits for an owned run and returns its terminal persisted view', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const controller = new AbortController()
    const spawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context())

    let settled = false
    const waiting = execute(
      spawnCall({ action: 'wait', handle: spawn.handle }),
      context({ signal: controller.signal })
    ).then(result => {
      settled = true
      return result as any
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(runner.waitCalls).toEqual([{ handle: spawn.handle, signal: controller.signal }])

    runner.setStatus(spawn.handle, 'completed')
    const result = await waiting
    expect(result).toMatchObject({
      action: 'wait',
      found: true,
      subagent: { handle: spawn.handle, status: 'completed', live: false, result: 'finished result' },
    })
  })

  it('wait returns terminal runs immediately and preserves branch isolation', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const branchB = context({ lineageId: 'lin-B' })
    const spawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), branchB)
    runner.setStatus(spawn.handle, 'error')

    const owned: any = await execute(spawnCall({ action: 'wait', handle: spawn.handle }), branchB)
    expect(owned.subagent).toMatchObject({ status: 'error', resumable: true, error: 'boom' })

    const crossBranch: any = await execute(
      spawnCall({ action: 'wait', handle: spawn.handle }),
      context({ lineageId: 'lin-A' })
    )
    expect(crossBranch).toMatchObject({ action: 'wait', found: false })
    expect(runner.waitCalls).toHaveLength(1)
  })

  it('requires a handle to wait', async () => {
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner: new FakeManagerRunner() })
    await expect(execute(spawnCall({ action: 'wait' }), context())).rejects.toThrow('wait: a handle is required')
  })

  it('list filters by status and flags resumable terminal runs', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const s1: any = await execute(spawnCall({ action: 'spawn', prompt: 'a' }), context())
    await execute(spawnCall({ action: 'spawn', prompt: 'b' }), context())
    runner.setStatus(s1.handle, 'error')

    const errored: any = await execute(spawnCall({ action: 'list', status: 'error' }), context())
    expect(errored.count).toBe(1)
    expect(errored.subagents[0].handle).toBe(s1.handle)
    expect(errored.subagents[0].resumable).toBe(true)
  })

  it('cancels an owned live run', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const spawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context())

    const cancel: any = await execute(spawnCall({ action: 'cancel', handle: spawn.handle }), context())
    expect(cancel.cancelled).toBe(true)
    expect(cancel.status).toBe('aborting')
    expect(runner.isActive(spawn.handle)).toBe(false)
  })

  it('resumes an owned terminated run in the background', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const spawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context())
    runner.setStatus(spawn.handle, 'error')

    const resume: any = await execute(spawnCall({ action: 'resume', handle: spawn.handle }), context())
    expect(resume.action).toBe('resume')
    expect(resume.resumed).toBe(true)
    expect(resume.status).toBe('running')
    expect(resume.streamId).toBe(`stream-${resume.runId}-resumed`)
    // The run was reopened via the runner, and is live again.
    expect(runner.resumeCalls).toHaveLength(1)
    expect(runner.resumeCalls[0].runId).toBe(resume.runId)
    expect(runner.isActive(spawn.handle)).toBe(true)
  })

  it('does not resume a completed run (nothing to resume)', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const spawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context())
    runner.setStatus(spawn.handle, 'completed')

    const resume: any = await execute(spawnCall({ action: 'resume', handle: spawn.handle }), context())
    expect(resume.resumed).toBe(false)
    expect(resume.status).toBe('completed')
    expect(resume.message).toContain('nothing to resume')
    // Gated before touching the engine.
    expect(runner.resumeCalls).toHaveLength(0)
  })

  it('does not resume a still-running run', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    const spawn: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context())

    const resume: any = await execute(spawnCall({ action: 'resume', handle: spawn.handle }), context())
    expect(resume.resumed).toBe(false)
    expect(resume.status).toBe('running')
    expect(resume.message).toContain('already running')
    expect(runner.resumeCalls).toHaveLength(0)
  })

  it('does not resume another branch\'s run (identical not-owned shape)', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    // Branch B owns an errored run.
    const spawnB: any = await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context({ lineageId: 'lin-B' }))
    runner.setStatus(spawnB.handle, 'error')

    // Branch A tries to resume B's handle.
    const resume: any = await execute(
      spawnCall({ action: 'resume', handle: spawnB.handle }),
      context({ lineageId: 'lin-A' })
    )
    expect(resume.resumed).toBe(false)
    expect(resume.found).toBe(false)
    expect(runner.resumeCalls).toHaveLength(0)
    // B's run was never reopened.
    expect(runner.getRunByHandle(spawnB.handle)?.status).toBe('error')
  })

  it('does not leak runs when the branch has no lineage', async () => {
    const runner = new FakeManagerRunner()
    const execute = createSubagentManagerExecutor({ leafExecutor: vi.fn(), runner })
    // Seed a lineaged run, then list from a context with no lineage.
    await execute(spawnCall({ action: 'spawn', prompt: 'p' }), context({ lineageId: 'lin-X' }))

    const list: any = await execute(spawnCall({ action: 'list' }), context({ lineageId: null }))
    expect(list.count).toBe(0)
    expect(list.subagents).toEqual([])
  })
})
