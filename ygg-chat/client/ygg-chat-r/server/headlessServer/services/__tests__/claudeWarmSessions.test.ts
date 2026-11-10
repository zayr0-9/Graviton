import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ClaudeSessionService } from '../claudeSessionService.js'
import { DecisionBroker } from '../decisionBroker.js'
import { EventPump, InputChannel } from '../claudeWarmChannel.js'
import { bumpClaudeConfigEpoch, claudeIdleEvent, claudeLaunchKey, claudeWarmConfigFromEnv } from '../claudeWarmProcess.js'

const WARM = { idleMs: 60_000, maxParked: 3, maxAgeMs: 60 * 60_000 }
const textOf = (message: any) => typeof message.message.content === 'string' ? message.message.content
  : message.message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')

type Turn = (prompt: string, n: number, cli: FakeCli) => AsyncGenerator<any> | any[]

/**
 * A Claude CLI the way CLI 2.1.318 behaves in streaming-input mode: it blocks between turns,
 * acknowledges each prompt (command_lifecycle queued → started, then completed after `result`),
 * opens every turn with init, applies live settings, and ends on abort or close.
 */
class FakeCli {
  prompts: any[] = []
  ended = false
  options: any
  private wakeEnd = () => {}
  private ending = new Promise<void>(resolve => { this.wakeEnd = resolve })
  private spontaneous: any[][] = []
  private wakeSpontaneous = () => {}
  setPermissionMode = vi.fn(async (_mode: string) => {})
  setModel = vi.fn(async (_model?: string) => {})
  applyFlagSettings = vi.fn(async (_settings: any) => {})
  mcpServerStatus = vi.fn(async () => [] as any[])
  stopTask = vi.fn(async () => {})
  close = vi.fn(() => this.end())
  /** Events the CLI emits for turn `n` before it acknowledges the prompt. */
  beforeAck: (n: number) => any[] = () => []
  constructor(public turn: Turn, public sessionId = 's', public tail = { uuid: '' }) {}
  end() { this.ended = true; this.wakeEnd() }
  /** The CLI starts a turn with no prompt (a background-task answer, a scheduled prompt). */
  selfStart(events: any[] = [{ type: 'system', subtype: 'init', session_id: this.sessionId }]) { this.spontaneous.push(events); this.wakeSpontaneous() }
  async *run(prompt: AsyncIterable<any>) {
    const input = prompt[Symbol.asyncIterator]()
    let pending: Promise<IteratorResult<any>> | null = null
    let n = 0
    while (!this.ended) {
      pending ??= input.next()
      const woke = new Promise<'self'>(resolve => { this.wakeSpontaneous = () => resolve('self') })
      if (this.spontaneous.length) this.wakeSpontaneous()
      const next = await Promise.race([pending, this.ending.then(() => 'end' as const), woke])
      if (next === 'end') return
      if (next === 'self') { for (const event of this.spontaneous.shift() ?? []) yield event; continue }
      pending = null
      if (next.done) return
      const message = next.value
      this.prompts.push(message)
      n++
      for (const event of this.beforeAck(n)) yield event
      yield { type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' }
      yield { type: 'command_lifecycle', command_uuid: message.uuid, state: 'started' }
      for await (const event of this.turn(textOf(message), n, this)) {
        if (this.ended) return
        yield event
      }
      yield { type: 'command_lifecycle', command_uuid: message.uuid, state: 'completed' }
    }
  }
}

function defaultTurn(prompt: string, n: number, cli: FakeCli) {
  cli.tail.uuid = `a${n}`
  return [{ type: 'system', subtype: 'init', session_id: cli.sessionId, permissionMode: 'default', mcp_servers: [] },
    { type: 'assistant', uuid: `a${n}`, session_id: cli.sessionId, parent_tool_use_id: null, message: { id: `m${n}`, content: [{ type: 'text', text: `reply to ${prompt}` }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: cli.sessionId }]
}

function warmFixture(options: { warm?: any; turn?: Turn; nativeMcp?: any } = {}) {
  const records = new Map<string, any>()
  const tail = { uuid: '' }
  const branches = new Map<string, any>()
  const sessions = {
    branch: vi.fn((lineage: string) => branches.get(lineage)), checkpoint: vi.fn((id: string) => records.get(id)), reserve: vi.fn(),
    session: vi.fn((lineage: string, session_id: string, state: string) => { branches.set(lineage, { session_id, state }) }),
    record: vi.fn((row: string, session_id: string, message_uuid: string, cwd: string, resumable: boolean) => records.set(row, { session_id, message_uuid, cwd, resumable: resumable ? 1 : 0 })),
  }
  const clis: FakeCli[] = []
  const sdk = {
    query: vi.fn(({ prompt, options: queryOptions }: any) => {
      const cli = new FakeCli(options.turn ?? defaultTurn, 's', tail)
      cli.options = queryOptions
      queryOptions.abortController?.signal.addEventListener('abort', () => cli.end(), { once: true })
      clis.push(cli)
      return Object.assign(cli.run(prompt), { close: cli.close, setPermissionMode: cli.setPermissionMode, setModel: cli.setModel,
        applyFlagSettings: cli.applyFlagSettings, mcpServerStatus: cli.mcpServerStatus, stopTask: cli.stopTask })
    }),
    forkSession: vi.fn(async () => ({ sessionId: 'forked' })),
    getSessionMessages: vi.fn(async () => [{ uuid: tail.uuid }]),
  }
  let rowCount = 0
  const rows: any[] = []
  const sink = { persistAssistantMessage: vi.fn((draft: any) => { const row = { ...draft, id: `row${rowCount++}` }; rows.push(row); return row }),
    updateAssistantToolState: vi.fn((id: string, update: any) => ({ ...rows.find(row => row.id === id), ...update })) }
  const broker = new DecisionBroker()
  broker.initSession('stream', { autoApproveAll: true })
  const service = new ClaudeSessionService({ sessions: sessions as any, broker, executable: async () => '/mock/claude', sdk: async () => sdk as any, hookRuns: null,
    messages: { get: vi.fn(() => null), updateClaudeProjection: vi.fn((id: string, content: string, content_blocks: any, meta: any) => ({ id, content, content_blocks, meta })) } as any,
    warm: options.warm === undefined ? WARM : options.warm, ...(options.nativeMcp ? { nativeMcp: () => options.nativeMcp } : {}) })
  const emit = vi.fn()
  const input = (overrides: any = {}) => ({ request: { conversationId: 'c', provider: 'Claude Code', modelName: 'claude-sonnet-5-5', content: 'first', streamId: 'stream', operationMode: 'execute', ...overrides.request },
    lineageId: 'l', userMessage: { id: 'u' }, parentId: 'u', sourceMessageId: null, fork: false, cwd: '/workspace', sink, emit, ...overrides, ...(overrides.request ? { request: { conversationId: 'c', provider: 'Claude Code', modelName: 'claude-sonnet-5-5', content: 'first', streamId: 'stream', operationMode: 'execute', ...overrides.request } } : {}) })
  /** A send continuing at the head the previous run returned. */
  const next = (previous: any, overrides: any = {}) => input({ parentId: previous.id, sourceMessageId: previous.id, ...overrides, request: { content: 'again', ...overrides.request } })
  return { service, sdk, clis, sessions, records, rows, emit, input, next, state: (lineage = 'l') => branches.get(lineage) }
}

afterEach(() => { vi.useRealTimers() })

describe('warm channel primitives', () => {
  it('hands a read left waiting to the next reader, losing nothing', async () => {
    const channel = new InputChannel<number>()
    const pump = new EventPump(channel.stream())
    const held = pump.next()
    channel.push(1)
    expect(pump.next()).toBe(held)
    await expect(held).resolves.toEqual({ value: 1, done: false })
    pump.consume()
    channel.push(2)
    channel.close()
    await expect(pump.next()).resolves.toEqual({ value: 2, done: false })
    pump.consume()
    await expect(pump.next()).resolves.toMatchObject({ done: true })
    expect(pump.done).toBe(true)
  })

  it('never leaves a failed read unhandled and drains to the exit', async () => {
    async function* failing() { yield 1; throw new Error('exited with code 1') }
    const pump = new EventPump(failing())
    await pump.next(); pump.consume()
    const failed = pump.next()
    await expect(failed).rejects.toThrow('exited with code 1')
    expect(pump.done).toBe(true)
    await pump.drain(100)
  })

  it('reads its config from the environment and can be turned off', () => {
    expect(claudeWarmConfigFromEnv({})).toEqual({ idleMs: 600_000, maxParked: 3, maxAgeMs: 3_600_000 })
    expect(claudeWarmConfigFromEnv({ GRAVITON_CLAUDE_WARM_IDLE_MS: '0' })).toBeNull()
    expect(claudeWarmConfigFromEnv({ GRAVITON_CLAUDE_WARM_MAX: '0' })).toBeNull()
    expect(claudeWarmConfigFromEnv({ GRAVITON_CLAUDE_WARM_IDLE_MS: '5000', GRAVITON_CLAUDE_WARM_MAX: 'x' })).toMatchObject({ idleMs: 5000, maxParked: 3 })
  })

  it('treats only idle chatter as idle', () => {
    for (const event of [{ type: 'rate_limit_event' }, { type: 'command_lifecycle', state: 'completed' }, { type: 'system', subtype: 'hook_response' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] }, { type: 'system', subtype: 'status', status: null }]) expect(claudeIdleEvent(event as any)).toBe(true)
    for (const event of [{ type: 'system', subtype: 'init' }, { type: 'assistant' }, { type: 'stream_event' }, { type: 'result' }, { type: 'command_lifecycle', state: 'started' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{}] }, { type: 'system', subtype: 'task_started' }, { type: 'system', subtype: 'status', status: 'compacting' }]) {
      expect(claudeIdleEvent(event as any)).toBe(false)
    }
  })

  it('changes the launch key when a settings file Claude read at launch changes, or the epoch moves', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'graviton-warm-key-'))
    try {
      const base = { cwd, adaptiveThinking: true, mcp: { strictMcpConfig: true }, plansDirectory: '.ygg/plans', executable: '/mock/claude', hookShape: 'native-only' }
      const first = await claudeLaunchKey(base)
      expect(await claudeLaunchKey(base)).toBe(first)
      await writeFile(path.join(cwd, '.mcp.json'), '{"mcpServers":{}}')
      const withMcp = await claudeLaunchKey(base)
      expect(withMcp).not.toBe(first)
      bumpClaudeConfigEpoch()
      expect(await claudeLaunchKey(base)).not.toBe(withMcp)
      expect(await claudeLaunchKey({ ...base, additionalDirectories: ['/b', '/a'] })).toBe(await claudeLaunchKey({ ...base, additionalDirectories: ['/a', '/b'] }))
      expect(await claudeLaunchKey({ ...base, hookShape: 'graviton-hooks' })).not.toBe(await claudeLaunchKey(base))
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })
})

describe('warm Claude sessions', () => {
  it('pushes the next send at the head into the same CLI, applying this turn\'s live settings', async () => {
    const f = warmFixture()
    const first = await f.service.run(f.input({ request: { think: true } }))
    expect(f.service.warmLineages()).toEqual(['l'])
    expect(f.clis[0].ended).toBe(false)
    const second = await f.service.run(f.next(first, { request: { modelName: 'claude-opus-5-5', claudeUltracode: true, think: true, reasoningConfig: { effort: 'high' } } }))
    expect(f.sdk.query).toHaveBeenCalledTimes(1)
    expect(f.clis[0].prompts.map(textOf)).toEqual(['first', 'again'])
    expect(second.content).toBe('reply to again')
    expect(second.meta.claude).toMatchObject({ sessionId: 's', checkpoint: true })
    expect(f.records.get(second.id)).toMatchObject({ message_uuid: 'a2', resumable: 1 })
    // A reused CLI's transcript is its own: no tail read, no fork.
    expect(f.sdk.getSessionMessages).not.toHaveBeenCalled()
    expect(f.sdk.forkSession).not.toHaveBeenCalled()
    const cli = f.clis[0]
    expect(cli.setPermissionMode).toHaveBeenCalledWith('default')
    expect(cli.setModel).toHaveBeenCalledWith('claude-opus-5-5')
    expect(cli.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high', ultracode: true })
    expect(f.state()).toEqual({ session_id: 's', state: 'ready' })
    // Plan mode is per turn too: the reused CLI is told before the prompt.
    const third = await f.service.run(f.next(second, { request: { think: true, claudePlanMode: true } }))
    expect(f.sdk.query).toHaveBeenCalledTimes(1)
    expect(cli.setPermissionMode).toHaveBeenLastCalledWith('plan')
    // Turning thinking on or off is fixed at launch: that send gets a new CLI.
    await f.service.run(f.next(third))
    expect(f.sdk.query).toHaveBeenCalledTimes(2)
  })

  it('clears effort and ultracode explicitly, and skips setModel when the model is unchanged', async () => {
    const f = warmFixture()
    const first = await f.service.run(f.input({ request: { think: true, reasoningConfig: { effort: 'high' }, claudeUltracode: true } }))
    await f.service.run(f.next(first, { request: { think: true } }))
    expect(f.sdk.query).toHaveBeenCalledTimes(1)
    expect(f.clis[0].setModel).not.toHaveBeenCalled()
    expect(f.clis[0].applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null, ultracode: false })
  })

  it('starts a new CLI for anything but a send at the head, closing the kept one first', async () => {
    const f = warmFixture()
    const first = await f.service.run(f.input())
    // A fork from the head (repeat / edit / branch) never reuses the process.
    await f.service.run(f.next(first, { fork: true }))
    expect(f.clis[0].close).toHaveBeenCalled()
    expect(f.sdk.query).toHaveBeenCalledTimes(2)
    expect(f.sdk.forkSession).toHaveBeenCalled()
    // Its own process parked at its own head; a send from an older row also goes cold.
    await f.service.run(f.next(first))
    expect(f.clis[1].close).toHaveBeenCalled()
    expect(f.sdk.query).toHaveBeenCalledTimes(3)
  })

  it('relaunches when a launch setting changes', async () => {
    const f = warmFixture()
    const first = await f.service.run(f.input())
    await f.service.run(f.next(first, { additionalDirectories: ['/other'] }))
    expect(f.sdk.query).toHaveBeenCalledTimes(2)
    expect(f.clis[0].close).toHaveBeenCalled()
    expect(f.sdk.query.mock.calls[1][0].options.resume).toBe('s')
  })

  it('relaunches instead of reusing a CLI with a failed MCP server', async () => {
    const f = warmFixture({ nativeMcp: { enabled: true, claudeAiConnectors: true, disabledServers: ['hidden'] } })
    const first = await f.service.run(f.input())
    f.clis[0].mcpServerStatus.mockResolvedValue([{ name: 'hidden', status: 'failed' }])
    const second = await f.service.run(f.next(first))
    expect(f.sdk.query).toHaveBeenCalledTimes(1)
    f.clis[0].mcpServerStatus.mockResolvedValue([{ name: 'linear', status: 'failed' }])
    await f.service.run(f.next(second))
    expect(f.sdk.query).toHaveBeenCalledTimes(2)
    expect(f.clis[0].ended).toBe(true)
  })

  it('a stop after an earlier result in the same run fails the run instead of returning a mid-turn checkpoint', async () => {
    let block: () => void = () => {}
    const f = warmFixture({ turn: async function* (prompt, n, cli) {
      // The turn ends while a background task keeps the run open, then the user stops.
      yield { type: 'system', subtype: 'init', session_id: cli.sessionId }
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't', task_type: 'local_bash', description: 'watch' }] }
      yield { type: 'assistant', uuid: `a${n}`, session_id: cli.sessionId, parent_tool_use_id: null, message: { id: `m${n}`, content: [{ type: 'text', text: 'working' }] } }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: cli.sessionId }
      await new Promise<void>(resolve => { block = resolve })
    } })
    const controller = new AbortController()
    const running = f.service.run(f.input({ signal: controller.signal }))
    await vi.waitFor(() => expect(f.rows.length).toBe(1))
    controller.abort()
    await expect(running).rejects.toThrow()
    block()
    expect(f.state().state).not.toBe('ready')
    expect(f.clis[0].ended).toBe(true)
    expect(f.service.warmLineages()).toEqual([])
  })

  it('never keeps a CLI that still reports tasks, ambient ones included', async () => {
    const f = warmFixture({ turn: (prompt, n, cli) => [...defaultTurn(prompt, n, cli).slice(0, 2),
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w', task_type: 'local_bash', description: 'watcher', ambient: true }] },
      ...defaultTurn(prompt, n, cli).slice(2)] })
    await f.service.run(f.input())
    expect(f.service.warmLineages()).toEqual([])
    expect(f.clis[0].ended).toBe(true)
  })

  it('closes a parked CLI that starts work by itself and makes the next send fork', async () => {
    const f = warmFixture()
    const first = await f.service.run(f.input())
    f.clis[0].selfStart()
    await vi.waitFor(() => expect(f.clis[0].ended).toBe(true))
    expect(f.state()).toEqual({ session_id: 's', state: 'interrupted' })
    expect(f.service.warmLineages()).toEqual([])
    await f.service.run(f.next(first))
    expect(f.sdk.query).toHaveBeenCalledTimes(2)
    expect(f.sdk.forkSession).toHaveBeenCalledWith('s', { dir: '/workspace', upToMessageId: 'a1' })
  })

  it('falls back to a new CLI when the kept one starts work while being claimed', async () => {
    const f = warmFixture()
    const first = await f.service.run(f.input())
    f.clis[0].setPermissionMode.mockImplementation(async () => {
      f.clis[0].selfStart()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    const second = await f.service.run(f.next(first))
    expect(f.sdk.query).toHaveBeenCalledTimes(2)
    expect(f.clis[0].ended).toBe(true)
    expect(f.clis[1].prompts.map(textOf)).toEqual(['again'])
    expect(second.content).toBe('reply to again')
    // The self-started turn moved the tail: the cold path forked at the checkpoint.
    expect(f.sdk.forkSession).toHaveBeenCalled()
  })

  it.each([
    ['a held message of an earlier run', [{ type: 'command_lifecycle', command_uuid: 'stale', state: 'queued' }, { type: 'command_lifecycle', command_uuid: 'stale', state: 'started' }]],
    ['a turn of its own', [{ type: 'system', subtype: 'init', session_id: 's' }]],
  ])('refuses a reused CLI that starts %s before this send\'s prompt', async (_label, early) => {
    const f = warmFixture()
    const first = await f.service.run(f.input())
    f.clis[0].beforeAck = n => n === 2 ? early : []
    await expect(f.service.run(f.next(first))).rejects.toThrow('did not ask for')
    // Nothing of it was projected, and the next send forks at the checkpoint.
    expect(f.rows).toHaveLength(1)
    expect(['uncertain', 'interrupted']).toContain(f.state().state)
    expect(f.clis[0].ended).toBe(true)
    expect(f.service.warmLineages()).toEqual([])
  })

  it('keeps PreToolUse closed and denies permissions while no run owns the CLI', async () => {
    const f = warmFixture()
    await f.service.run(f.input())
    const options = f.clis[0].options
    const hook = options.hooks.PreToolUse[0].hooks[0]
    await expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }, 't', { signal: new AbortController().signal }))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    await expect(options.canUseTool('Bash', {}, { signal: new AbortController().signal, toolUseID: 'x' })).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('closes a CLI that sits unused past the idle time, and the longest-unused one past the cap', async () => {
    const f = warmFixture({ warm: { idleMs: 30, maxParked: 1, maxAgeMs: 60_000 } })
    await f.service.run(f.input())
    await f.service.run(f.input({ lineageId: 'l2' }))
    expect(f.clis[0].ended).toBe(true)
    expect(f.service.warmLineages()).toEqual(['l2'])
    await vi.waitFor(() => expect(f.clis[1].ended).toBe(true))
    expect(f.service.warmLineages()).toEqual([])
  })

  it('does not park a CLI past its maximum age, and host shutdown closes parked ones', async () => {
    const old = warmFixture({ warm: { idleMs: 60_000, maxParked: 3, maxAgeMs: 0 } })
    await old.service.run(old.input())
    expect(old.service.warmLineages()).toEqual([])
    const f = warmFixture()
    await f.service.run(f.input())
    await f.service.dispose()
    expect(f.clis[0].ended).toBe(true)
    expect(f.service.warmLineages()).toEqual([])
  })

  it('does not park after a manual /compact', async () => {
    const f = warmFixture({ turn: async function* (_prompt, _n, cli) {
      yield { type: 'system', subtype: 'init', session_id: cli.sessionId }
      await cli.options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'manual', compact_summary: 'summary' }, undefined, { signal: new AbortController().signal })
      yield { type: 'system', subtype: 'compact_boundary', session_id: cli.sessionId }
      yield { type: 'result', subtype: 'success', is_error: false, session_id: cli.sessionId }
    } })
    await f.service.run(f.input({ request: { manualCompaction: true, content: '/compact' } }))
    expect(f.service.warmLineages()).toEqual([])
    expect(f.clis[0].ended).toBe(true)
  })

  it('without a warm config, every run gets its own CLI that ends with the run', async () => {
    const f = warmFixture({ warm: null })
    const first = await f.service.run(f.input())
    expect(f.clis[0].ended).toBe(true)
    await f.service.run(f.next(first))
    expect(f.sdk.query).toHaveBeenCalledTimes(2)
  })
})
