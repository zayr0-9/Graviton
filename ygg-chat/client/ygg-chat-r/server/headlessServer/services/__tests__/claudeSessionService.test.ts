import { describe, it, expect, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ClaudeSessionService, interruptedResumePoint, safeResumePoint } from '../claudeSessionService.js'
import { assertClaudeBranchSelection } from '../../persistence/claudeSessionRepo.js'
import { DecisionBroker } from '../decisionBroker.js'

function fixture(events: any[] = []) {
  const rows: any[] = []
  const state: any = {}
  const sessions = {
    branch: vi.fn(() => state.branch), checkpoint: vi.fn(() => state.checkpoint), reserve: vi.fn(),
    session: vi.fn((_lineage, session_id, status) => { state.branch = { session_id, state: status } }), record: vi.fn(),
  }
  const sdk = { query: vi.fn(() => Object.assign((async function* () { for (const event of events) yield event })(), { close: vi.fn() })),
    forkSession: vi.fn(async () => ({ sessionId: 'fork' })),
    getSessionMessages: vi.fn(async () => [{ uuid: 'checkpoint' }]),
  }
  const sink = { persistAssistantMessage: vi.fn(draft => { const row = { ...draft, id: `row${rows.length}` }; rows.push(row); return row }),
    updateAssistantToolState: vi.fn((id, update) => ({ ...rows.find(row => row.id === id), ...update })),
  }
  const broker = new DecisionBroker()
  broker.initSession('stream', { autoApproveAll: false })
  const emit = vi.fn()
  const input: any = { request: { conversationId: 'c', provider: 'Claude Code', modelName: 'claude-sonnet-5-5', content: 'hello', streamId: 'stream', operationMode: 'execute' },
    lineageId: 'l', userMessage: { id: 'u' }, parentId: 'u', sourceMessageId: null, fork: false, cwd: '/workspace', sink, emit }
  const service = new ClaudeSessionService({ sessions: sessions as any, messages: { get: vi.fn(() => null), updateClaudeProjection: vi.fn((id, content, contentBlocks, meta) => ({ id, content, content_blocks: contentBlocks, meta })) } as any, broker, executable: async () => '/mock/claude', sdk: async () => sdk as any })
  return { service, input, sdk, sessions, state, sink, rows, emit, broker }
}
const assistant = (uuid = 'a', content: any[] = [{ type: 'text', text: 'answer' }]) => ({ type: 'assistant', uuid, session_id: 's', parent_tool_use_id: null, message: { content } })
const success = { type: 'result', subtype: 'success', is_error: false, session_id: 's' }

describe('Claude native session backend', () => {
  it('uses Claude tools and transcript, projects a completed response and records checkpoint', async () => {
    const f = fixture([assistant(), success])
    const final = await f.service.run(f.input)
    expect(final.content).toBe('answer')
    expect(final.meta.claude.checkpoint).toBe(true)
    expect(f.sdk.query.mock.calls[0][0].options).toMatchObject({ model: 'claude-sonnet-5-5', permissionMode: 'default', strictMcpConfig: true, persistSession: true })
    expect(f.sessions.record).toHaveBeenLastCalledWith(final.id, 's', 'a', '/workspace', true)
    expect(f.sessions.session).toHaveBeenLastCalledWith('l', 's', 'ready')
  })
  it.each(['low', 'medium', 'high', 'xhigh'])('passes slider effort %s to adaptive thinking on new, resumed and forked turns', async effort => {
    for (const mode of ['new', 'resume', 'fork']) {
      const f = fixture([assistant(), success])
      f.input.request.think = true
      f.input.request.reasoningConfig = { effort }
      if (mode !== 'new') {
        f.state.branch = { session_id: 'source', state: 'ready' }
        f.state.checkpoint = { session_id: 'source', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
        f.input.sourceMessageId = 'tail'
        f.input.fork = mode === 'fork'
      }
      await f.service.run(f.input)
      expect(f.sdk.query.mock.calls[0][0].options).toMatchObject({ effort, thinking: { type: 'adaptive' } })
    }
  })
  it('sends this turn\'s images as native image blocks ahead of the text', async () => {
    const f = fixture([assistant(), success])
    f.input.images = ['data:image/png;base64,iVBORw0KGgo=']
    await f.service.run(f.input)
    const { value } = await f.sdk.query.mock.calls[0][0].prompt.next()
    expect(value.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'hello' },
    ])
  })
  it('keeps plain string content when no images are attached', async () => {
    const f = fixture([assistant(), success])
    await f.service.run(f.input)
    const { value } = await f.sdk.query.mock.calls[0][0].prompt.next()
    expect(value.message.content).toBe('hello')
  })
  it('rejects image formats Claude cannot read before reserving the branch', async () => {
    const f = fixture([assistant(), success])
    f.input.images = ['data:image/bmp;base64,Qk0=']
    await expect(f.service.run(f.input)).rejects.toThrow('PNG, JPEG, GIF or WebP')
    expect(f.sessions.reserve).not.toHaveBeenCalled()
    expect(f.sdk.query).not.toHaveBeenCalled()
  })
  it('disables thinking for slider Off even with stale effort', async () => {
    const f = fixture([assistant(), success])
    f.input.request.think = false
    f.input.request.reasoningConfig = { effort: 'xhigh' }
    await f.service.run(f.input)
    const options = f.sdk.query.mock.calls[0][0].options
    expect(options.thinking).toEqual({ type: 'disabled' })
    expect(options).not.toHaveProperty('effort')
  })
  it.each([undefined, { effort: 'invalid' }])('preserves native defaults when no valid reasoning selection is provided: %j', async reasoningConfig => {
    const f = fixture([assistant(), success])
    f.input.request.reasoningConfig = reasoningConfig
    await f.service.run(f.input)
    const options = f.sdk.query.mock.calls[0][0].options
    expect(options).not.toHaveProperty('effort')
    expect(options).not.toHaveProperty('thinking')
  })
  it('accepts effort without the legacy thinking flag and enables adaptive thinking', async () => {
    const f = fixture([assistant(), success])
    f.input.request.reasoningConfig = { effort: 'medium' }
    await f.service.run(f.input)
    expect(f.sdk.query.mock.calls[0][0].options).toMatchObject({ effort: 'medium', thinking: { type: 'adaptive' } })
  })
  it('merges thinking and text blocks from one API response into one Heimdall node', async () => {
    const f = fixture([{ ...assistant('thinking', [{ type: 'thinking', thinking: 'reason' }]), message: { id: 'api', content: [{ type: 'thinking', thinking: 'reason' }] } },
      { ...assistant('text'), message: { id: 'api', content: [{ type: 'text', text: 'answer' }] } }, success])
    const final = await f.service.run(f.input)
    expect(f.sink.persistAssistantMessage).toHaveBeenCalledTimes(1)
    expect(final.content_blocks.map((block: any) => block.type)).toEqual(['thinking', 'text'])
    expect(f.sessions.record).toHaveBeenLastCalledWith('row0', 's', 'text', '/workspace', true)
  })
  it('merges partial Stop text into its existing response instead of making a second node', async () => {
    const f = fixture([{ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'api' } } },
      { ...assistant('thinking'), message: { id: 'api', content: [{ type: 'thinking', thinking: 'reason' }] } },
      { type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'unfinished' } } }])
    await expect(f.service.run(f.input)).rejects.toThrow('without a completed response')
    expect(f.sink.persistAssistantMessage).toHaveBeenCalledTimes(1)
    expect(f.emit.mock.calls.at(-1)?.[0]).toMatchObject({ message: { id: 'row0', content: 'unfinished', meta: { claude: { partial: true, checkpoint: false } } } })
  })
  it('merges text and tool use then enriches the same response with native results', async () => {
    const f = fixture([{ ...assistant('text'), message: { id: 'api', content: [{ type: 'text', text: 'Reading' }] } },
      { ...assistant('tool'), message: { id: 'api', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
      { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'result' }] } },
      assistant('final'), success])
    await f.service.run(f.input)
    expect(f.sink.persistAssistantMessage).toHaveBeenCalledTimes(2)
    expect(f.sink.updateAssistantToolState).toHaveBeenCalledWith('row0', expect.objectContaining({ contentBlocks: expect.arrayContaining([
      expect.objectContaining({ type: 'text', content: 'Reading' }), expect.objectContaining({ type: 'tool_use', id: 't' }), expect.objectContaining({ type: 'tool_result', tool_use_id: 't' }),
    ]) }))
  })
  it('resumes a ready session without copying it when the selected checkpoint is the tail', async () => {
    const f = fixture([assistant(), success])
    f.state.branch = { session_id: 'source', state: 'ready' }
    f.state.checkpoint = { session_id: 'source', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
    f.input.sourceMessageId = 'tail'
    await f.service.run(f.input)
    expect(f.sdk.forkSession).not.toHaveBeenCalled()
    expect(f.sdk.query.mock.calls[0][0].options.resume).toBe('source')
    expect(f.sessions.session.mock.calls.filter(call => call[2] === 'running')).toHaveLength(1)
  })
  it('forks at the exact mapped message, not latest history, and leaves the source session alone', async () => {
    const f = fixture([assistant(), success])
    f.state.checkpoint = { session_id: 'source', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
    f.input.sourceMessageId = 'old-node'; f.input.fork = true
    await f.service.run(f.input)
    expect(f.sdk.forkSession).toHaveBeenCalledWith('source', { dir: '/workspace', upToMessageId: 'checkpoint' })
    expect(f.sdk.query.mock.calls[0][0].options.resume).toBe('fork')
  })
  it('refuses missing native session data instead of inventing a fresh transcript', async () => {
    const f = fixture()
    f.state.checkpoint = { session_id: 'gone', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
    f.input.sourceMessageId = 'old'
    f.sdk.getSessionMessages.mockRejectedValue(new Error('session data is unavailable'))
    await expect(f.service.run(f.input)).rejects.toThrow('session data is unavailable')
    expect(f.sdk.query).not.toHaveBeenCalled()
  })
  it('does not fork from incomplete tool/stream boundaries', async () => {
    const f = fixture()
    f.input.sourceMessageId = 'tool'
    f.state.checkpoint = { resumable: 0 }
    await expect(f.service.run(f.input)).rejects.toThrow('not a completed Claude checkpoint')
  })
  it('routes native tool approval to the existing broker; denial reaches Claude', async () => {
    const f = fixture([assistant(), success])
    await f.service.run(f.input)
    const permission = f.sdk.query.mock.calls[0][0].options.canUseTool
    const decision = permission('Bash', { command: 'echo hi' }, { signal: new AbortController().signal, toolUseID: 'tool' })
    expect(f.broker.hasPending('stream', 'tool')).toBe(true)
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'permission_required', toolCallId: 'tool' }))
    f.broker.resolve('stream', 'tool', 'deny')
    await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
  })
  it('projects native tool calls/results without executing Graviton tools', async () => {
    const f = fixture([assistant('tool-a', [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a' } }]),
      { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'file text' }] } },
      assistant('final'), success])
    await f.service.run(f.input)
    expect(f.sink.updateAssistantToolState).toHaveBeenCalledWith('row0', expect.objectContaining({ contentBlocks: expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: 't', content: 'file text' })]) }))
    expect(f.rows[1].parentId).toBe('row0')
    expect(f.sessions.record).toHaveBeenLastCalledWith('row1', 's', 'final', '/workspace', true)
  })
  it('preserves partial text and marks interrupted sessions uncertain', async () => {
    const f = fixture([{ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } }])
    await expect(f.service.run(f.input)).rejects.toThrow('without a completed response')
    expect(f.rows[0].content).toBe('partial')
    expect(f.sessions.session).toHaveBeenLastCalledWith('l', 's', 'uncertain')
  })
  it('checkpoints an interrupted head at its last resolved tool result', async () => {
    const f = fixture([assistant('tool', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
      { type: 'user', uuid: 'result', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }])
    await expect(f.service.run(f.input)).rejects.toThrow('without a completed response')
    expect(f.sessions.record).toHaveBeenLastCalledWith('row0', 's', 'result', '/workspace', true)
    expect(f.sessions.session).toHaveBeenLastCalledWith('l', 's', 'interrupted')
  })
  it('resumes before a tool call that never got its result, but keeps the visible head', async () => {
    const f = fixture([{ ...assistant('said'), message: { id: 'api1', content: [{ type: 'text', text: 'Looking' }] } },
      { ...assistant('call'), message: { id: 'api2', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }])
    await expect(f.service.run(f.input)).rejects.toThrow('without a completed response')
    expect(f.sessions.record).toHaveBeenLastCalledWith('row1', 's', 'said', '/workspace', true)
    expect(f.sessions.session).toHaveBeenLastCalledWith('l', 's', 'interrupted')
  })
  it('never treats a thinking-only envelope as a resume point', async () => {
    const f = fixture([assistant('thought', [{ type: 'thinking', thinking: 'hmm' }])])
    await expect(f.service.run(f.input)).rejects.toThrow('without a completed response')
    expect(f.sessions.record).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), true)
    expect(f.sessions.session).toHaveBeenLastCalledWith('l', 's', 'uncertain')
  })
  it('continues an interrupted branch by forking at the checkpoint even when it is the native tail', async () => {
    const f = fixture([assistant(), success])
    f.state.branch = { session_id: 'source', state: 'interrupted' }
    f.state.checkpoint = { session_id: 'source', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
    f.input.sourceMessageId = 'head'
    await f.service.run(f.input)
    expect(f.sdk.forkSession).toHaveBeenCalledWith('source', { dir: '/workspace', upToMessageId: 'checkpoint' })
    expect(f.sdk.query.mock.calls[0][0].options.resume).toBe('fork')
  })
  it('still refuses to append to a branch whose run is live', async () => {
    const f = fixture([assistant(), success])
    f.state.branch = { session_id: 'source', state: 'running' }
    f.state.checkpoint = { session_id: 'source', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
    f.input.sourceMessageId = 'head'
    await expect(f.service.run(f.input)).rejects.toThrow('still running')
    expect(f.sdk.query).not.toHaveBeenCalled()
  })
})

describe('Interrupted Claude branch recovery', () => {
  const user = (uuid: string, content: any) => ({ type: 'user', uuid, message: { content } })
  const asst = (uuid: string, content: any[]) => ({ type: 'assistant', uuid, message: { content } })
  const chain = [user('p0', 'old prompt'), asst('old', [{ type: 'text', text: 'old answer' }]),
    user('p1', 'do it'), asst('a1', [{ type: 'tool_use', id: 't1' }]), user('r1', [{ type: 'tool_result', tool_use_id: 't1' }]),
    asst('a2', [{ type: 'text', text: 'never projected' }]), asst('a3', [{ type: 'tool_use', id: 't2' }])]
  it('includes results of the head call that Graviton never projected, and nothing after', () => {
    expect(interruptedResumePoint(chain, 'a1')).toBe('r1')
  })
  it('never reaches back past the turn prompt', () => {
    expect(interruptedResumePoint(chain.slice(0, 4), 'a1')).toBeNull()
    expect(interruptedResumePoint(chain, 'missing')).toBeNull()
  })
  it('safe points require every call resolved', () => {
    expect(safeResumePoint([{ uuid: 'a', toolUseIds: ['x', 'y'], toolResultIds: [], hasText: true },
      { uuid: 'r', toolUseIds: [], toolResultIds: ['x'], hasText: false }])).toBeNull()
  })
  it('releases stale running branches at startup and checkpoints recoverable heads', async () => {
    const sessions = {
      interruptedBranches: vi.fn(() => [{ lineage_id: 'l1', session_id: 's', cwd: '/w', head_message_id: 'head' },
        { lineage_id: 'l2', session_id: 's2', cwd: '/w', head_message_id: null }]),
      setState: vi.fn(), record: vi.fn(),
      checkpoint: vi.fn(() => ({ session_id: 's', message_uuid: 'a1', cwd: '/w', resumable: 0 })),
    }
    const sdk = { getSessionMessages: vi.fn(async () => chain) }
    const service = new ClaudeSessionService({ sessions: sessions as any, messages: {} as any, sdk: async () => sdk as any })
    await expect(service.recoverInterruptedBranches()).resolves.toBe(1)
    expect(sdk.getSessionMessages).toHaveBeenCalledWith('s', { dir: '/w' })
    expect(sessions.record).toHaveBeenCalledWith('head', 's', 'r1', '/w', true)
    expect(sessions.setState.mock.calls).toEqual([['l1', 'uncertain'], ['l2', 'uncertain'], ['l1', 'interrupted'], ['l2', 'interrupted']])
  })
})

describe('Claude branch locks', () => {
  const request: any = { provider: 'Claude Code', modelName: 'm' }
  const path = [{ meta: JSON.stringify({ modelSelection: { provider: 'Claude Code', model: 'm' } }) }]
  it('inherits exact identity and rejects provider/model changes', () => {
    expect(() => assertClaudeBranchSelection(request, path)).not.toThrow()
    expect(() => assertClaudeBranchSelection({ ...request, modelName: 'other' }, path)).toThrow('fixed provider')
    expect(() => assertClaudeBranchSelection({ ...request, provider: 'openrouter' }, path)).toThrow('fixed provider')
  })
  it('rejects importing other-provider history but accepts an empty conversation', () => {
    expect(() => assertClaudeBranchSelection(request, [{ meta: {} }])).toThrow('new conversation')
    expect(() => assertClaudeBranchSelection(request, [])).not.toThrow()
  })
  it('preserves existing non-Claude switching', () => {
    expect(() => assertClaudeBranchSelection({ provider: 'openrouter' } as any, [{ meta: {} }])).not.toThrow()
  })
})

it.skipIf(process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1')('live service: native tools, UI denial, projected response, continuation and historical fork', async () => {
  const { mkdtemp, writeFile, rm, access } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const native = await import('@anthropic-ai/claude-agent-sdk')
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-service-'))
  const f = fixture()
  f.input.cwd = cwd
  f.input.request.modelName = 'claude-haiku-5-5'
  f.input.request.content = 'Read fixture.txt using Read. Then use Write to create denied.txt with contents hello. If denied, do not try other tools. Reply with the fixture token and acknowledge denial.'
  await writeFile(path.join(cwd, 'fixture.txt'), 'Token: jade-wren-89')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 100_000)
  f.input.signal = controller.signal
  f.sdk.query.mockImplementation((args: any) => native.query({ ...args, options: { ...args.options,
    pathToClaudeCodeExecutable: process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude'), tools: ['Read', 'Write'] } }) as any)
  f.sdk.getSessionMessages.mockImplementation((...args: any[]) => native.getSessionMessages(args[0], args[1]) as any)
  f.sdk.forkSession.mockImplementation((...args: any[]) => native.forkSession(args[0], args[1]))
  f.input.emit = (event: any) => {
    f.emit(event)
    if (event.type === 'permission_required') f.broker.resolve('stream', event.toolCallId, 'deny')
  }
  try {
    const first = await f.service.run(f.input)
    expect(first.content).toContain('jade-wren-89')
    expect(f.emit.mock.calls.some(([event]) => event.type === 'permission_required' && event.toolName === 'Write')).toBe(true)
    await expect(access(path.join(cwd, 'denied.txt'))).rejects.toThrow()
    expect(f.emit.mock.calls.some(([event]) => event.type === 'chunk' && event.part === 'tool_result')).toBe(true)
    const [, session, uuid] = f.sessions.record.mock.calls.at(-1)!
    f.state.checkpoint = { session_id: session, message_uuid: uuid, cwd, resumable: 1 }
    f.input.sourceMessageId = first.id
    f.input.parentId = 'next-user'
    f.input.request.content = 'What was the fixture token? Reply only the token; do not use tools.'
    const second = await f.service.run(f.input)
    expect(second.content).toContain('jade-wren-89')
    expect(f.sdk.forkSession).not.toHaveBeenCalled()
    f.input.fork = true
    const forked = await f.service.run(f.input)
    expect(forked.content).toContain('jade-wren-89')
    expect(f.sdk.forkSession).toHaveBeenCalledWith(session, { dir: cwd, upToMessageId: uuid })
    const [, forkSessionId, forkUuid] = f.sessions.record.mock.calls.at(-1)!
    f.state.checkpoint = { session_id: forkSessionId, message_uuid: forkUuid, cwd, resumable: 1 }
    f.input.fork = false
    f.input.request.content = 'Use Write to create approved.txt with exact contents cobalt-fox-21. Do not use other tools. Reply done.'
    let approved = false
    f.input.emit = (event: any) => {
      f.emit(event)
      if (event.type === 'permission_required') { approved = true; f.broker.resolve('stream', event.toolCallId, 'allow_once') }
    }
    await f.service.run(f.input)
    expect(approved).toBe(true)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(path.join(cwd, 'approved.txt'), 'utf8')).toContain('cobalt-fox-21')
    const [, autoSessionId, autoUuid] = f.sessions.record.mock.calls.at(-1)!
    f.state.checkpoint = { session_id: autoSessionId, message_uuid: autoUuid, cwd, resumable: 1 }
    f.broker.initSession('stream', { autoApproveAll: true })
    f.emit.mockClear()
    f.input.emit = event => f.emit(event)
    f.input.request.content = 'Use Write to create auto-approved.txt with exact contents amber-wren-32. Do not use other tools. Reply done.'
    await f.service.run(f.input)
    expect(await readFile(path.join(cwd, 'auto-approved.txt'), 'utf8')).toContain('amber-wren-32')
    expect(f.emit.mock.calls.some(([event]) => event.type === 'permission_required')).toBe(false)
  } finally { clearTimeout(timer); controller.abort(); await rm(cwd, { recursive: true, force: true }) }
}, 120_000)

describe('Claude compaction projection', () => {
  it.each(['auto', 'manual'])('persists PostCompact %s summary through the normal sink and compaction event', async trigger => {
    const f = fixture()
    f.input.request.manualCompaction = trigger === 'manual'
    f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      await options.hooks.PreCompact[0].hooks[0]({ hook_event_name: 'PreCompact', session_id: 's', trigger }, undefined, { signal: new AbortController().signal })
      await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger, compact_summary: 'Portable task state' }, undefined, { signal: new AbortController().signal })
      yield { type: 'system', subtype: 'compact_boundary', session_id: 's' }
      if (trigger === 'auto') yield assistant('after')
      yield success
    })(), { close: vi.fn() }) as any)
    const final = await f.service.run(f.input)
    expect(f.rows[0]).toMatchObject({ content: 'Portable task state', parentId: 'u', statisticsKind: 'compaction_summary', meta: { kind: 'compaction_summary', state: 'committed', trigger } })
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'context_compaction', status: 'completed', parentMessageId: 'row0', summaryMessage: f.rows[0] }))
    if (trigger === 'auto') {
      expect(f.rows[1].parentId).toBe('row0')
      expect(final.content).toBe('answer')
    } else {
      expect(final).toEqual(f.rows[0])
      expect(f.sessions.record).not.toHaveBeenCalled()
    }
    expect(f.sdk.query.mock.calls[0][0].options.settings).toEqual({ disableAllHooks: true, plansDirectory: path.join('.ygg', 'plans') })
  })
  it('does not mistake a boundary without PostCompact text for a committed summary', async () => {
    const f = fixture([{ type: 'system', subtype: 'compact_boundary', session_id: 's' }, success])
    f.input.request.manualCompaction = true
    await expect(f.service.run(f.input)).rejects.toThrow('without supplying a PostCompact summary')
    expect(f.rows).toHaveLength(0)
    expect(f.sessions.session).toHaveBeenLastCalledWith('l', 's', 'uncertain')
  })
  it('ignores child-session hooks and late callbacks after Stop', async () => {
    const f = fixture()
    f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      const callback = options.hooks.PostCompact[0].hooks[0]
      await callback({ hook_event_name: 'PostCompact', session_id: 'child', trigger: 'auto', compact_summary: 'child' }, undefined, { signal: new AbortController().signal })
      await callback({ hook_event_name: 'PostCompact', session_id: 's', agent_id: 'child-worker', trigger: 'auto', compact_summary: 'same-session child' }, undefined, { signal: new AbortController().signal })
      const stopped = new AbortController(); stopped.abort()
      await callback({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'auto', compact_summary: 'late' }, undefined, { signal: stopped.signal })
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    await f.service.run(f.input)
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0].content).toBe('answer')
  })
})

it('orders buffered pre-compaction output before the summary despite early hook delivery', async () => {
  const f = fixture()
  f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' }
    await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'auto', compact_summary: 'handoff' }, undefined, { signal: new AbortController().signal })
    yield assistant('before')
    yield { type: 'system', subtype: 'compact_boundary', session_id: 's' }
    yield assistant('after')
    yield success
  })(), { close: vi.fn() }) as any)
  await f.service.run(f.input)
  expect(f.rows.map(row => [row.content, row.parentId])).toEqual([['answer', 'u'], ['handoff', 'row0'], ['answer', 'row1']])
})

it('delegates an exact historical cut absent from the compacted live projection to native forkSession', async () => {
  const f = fixture([assistant(), success])
  f.input.sourceMessageId = 'before-compact'; f.input.fork = true
  f.state.checkpoint = { session_id: 'source', message_uuid: 'old-checkpoint', cwd: '/workspace', resumable: 1 }
  f.sdk.getSessionMessages.mockResolvedValue([])
  await f.service.run(f.input)
  expect(f.sdk.forkSession).toHaveBeenCalledWith('source', { dir: '/workspace', upToMessageId: 'old-checkpoint' })
  const missing = fixture()
  missing.input.sourceMessageId = 'missing'; missing.input.fork = true
  missing.state.checkpoint = f.state.checkpoint
  missing.sdk.getSessionMessages.mockResolvedValue([])
  missing.sdk.forkSession.mockRejectedValue(new Error('cut not found'))
  await expect(missing.service.run(missing.input)).rejects.toThrow('cut not found')
  expect(missing.sdk.query).not.toHaveBeenCalled()
})

it.skipIf(process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1')('live service persists native compact and resumes from its summary without an assistant checkpoint', async () => {
  const native = await import('@anthropic-ai/claude-agent-sdk')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'graviton-compact-service-'))
  const f = fixture()
  f.input.cwd = cwd
  f.input.request.modelName = 'claude-haiku-5-5'
  f.input.request.content = 'Remember synthetic token indigo-kestrel-38. Reply ACK.'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  f.input.signal = controller.signal
  f.sdk.query.mockImplementation((args: any) => native.query({ ...args, options: { ...args.options,
    pathToClaudeCodeExecutable: process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude'), tools: [] } }) as any)
  f.sdk.getSessionMessages.mockImplementation((...args: any[]) => native.getSessionMessages(args[0], args[1]) as any)
  f.sdk.forkSession.mockImplementation((...args: any[]) => native.forkSession(args[0], args[1]))
  try {
    const first = await f.service.run(f.input)
    const [, session, uuid] = f.sessions.record.mock.calls.at(-1)!
    f.state.checkpoint = { session_id: session, message_uuid: uuid, cwd, resumable: 1 }
    f.input.sourceMessageId = first.id; f.input.parentId = 'compact-instruction'
    f.input.request.manualCompaction = true
    f.input.request.compactionSystemPrompt = 'This Graviton-only instruction must not be passed to native /compact'
    const summary = await f.service.run(f.input)
    expect(summary.meta).toMatchObject({ kind: 'compaction_summary', state: 'committed', trigger: 'manual' })
    expect(summary.content).toContain('indigo-kestrel-38')
    expect(f.emit.mock.calls.some(([event]) => event.type === 'context_compaction' && event.status === 'completed' && event.summaryMessage.id === summary.id)).toBe(true)
    const get = vi.fn(() => ({ ...summary, role: 'assistant' }))
    ;(f.service as any).deps.messages.get = get
    f.input.sourceMessageId = summary.id; f.input.parentId = 'followup'
    f.input.request.manualCompaction = false
    f.input.request.content = 'What synthetic test token did I ask you to remember? Reply only that token.'
    const next = await f.service.run(f.input)
    expect(next.content).toContain('indigo-kestrel-38')
    expect(f.sdk.forkSession).not.toHaveBeenCalled()
    expect(f.sessions.session).toHaveBeenLastCalledWith('l', session, 'ready')
  } finally { controller.abort(); clearTimeout(timer); await rm(cwd, { recursive: true, force: true }) }
}, 120000)

it('fails explicitly when hook text arrives without its ordered boundary', async () => {
  const f = fixture()
  f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' }
    await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'auto', compact_summary: 'uncommitted' }, undefined, { signal: new AbortController().signal })
    yield assistant(); yield success
  })(), { close: vi.fn() }) as any)
  await expect(f.service.run(f.input)).rejects.toThrow('without a completed compaction boundary')
  expect(f.rows.some(row => row.meta?.kind === 'compaction_summary')).toBe(false)
  expect(f.sessions.session).toHaveBeenLastCalledWith('l', 's', 'uncertain')
})

it('rejects resolved native slash commands before SDK invocation', async () => {
  const f = fixture()
  f.input.request.content = '/compact focus'
  await expect(f.service.run(f.input)).rejects.toThrow('explicit Graviton command')
  expect(f.sdk.query).not.toHaveBeenCalled()
})

it.each(['execute', 'plan'])('honors stream auto-approval in %s without SDK permission bypass', async operationMode => {
  const f = fixture([assistant(), success])
  f.input.request.operationMode = operationMode
  f.broker.initSession('stream', { autoApproveAll: true })
  await f.service.run(f.input)
  const options = f.sdk.query.mock.calls[0][0].options
  expect(options.permissionMode).toBe('default')
  expect(options.disallowedTools).toEqual(operationMode === 'plan' ? ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'EnterPlanMode', 'ExitPlanMode'] : undefined)
  expect(options.allowDangerouslySkipPermissions).not.toBe(true)
  await expect(options.canUseTool('Read', { file_path: 'file' }, {
    signal: new AbortController().signal, toolUseID: 'auto-tool',
  })).resolves.toMatchObject({ behavior: 'allow', updatedInput: { file_path: 'file' } })
  expect(f.emit.mock.calls.some(([event]) => event.type === 'permission_required')).toBe(false)
  for (const name of ['AskUserQuestion', ...(operationMode === 'plan' ? ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] : [])]) {
    await expect(options.canUseTool(name, {}, { signal: new AbortController().signal, toolUseID: name })).resolves.toMatchObject({ behavior: 'deny' })
  }
  // Chat mode is a conversation without file edits, not native plan mode: other tools follow the approval gate.
  for (const name of ['Bash', 'Agent']) {
    await expect(options.canUseTool(name, {}, { signal: new AbortController().signal, toolUseID: name })).resolves.toMatchObject({ behavior: 'allow' })
  }
})

it('runs the CLI in auto mode and still prompts for calls the classifier cannot decide', async () => {
  const f = fixture([{ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'auto' }, assistant(), success])
  f.input.request.claudePermissionMode = 'auto'
  await f.service.run(f.input)
  const options = f.sdk.query.mock.calls[0][0].options
  expect(options.permissionMode).toBe('auto')
  expect(f.emit.mock.calls.some(([event]) => event.code === 'claude_auto_unavailable')).toBe(false)
  const decision = options.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: 'bash' })
  await vi.waitFor(() => expect(f.broker.hasPending('stream', 'bash')).toBe(true))
  expect(f.emit.mock.calls.some(([event]) => event.type === 'permission_required' && event.toolCallId === 'bash')).toBe(true)
  f.broker.resolve('stream', 'bash', 'deny')
  await expect(decision).resolves.toMatchObject({ behavior: 'deny' })
})

it('warns when the CLI falls back from auto mode', async () => {
  const f = fixture([{ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'default' }, assistant(), success])
  f.input.request.claudePermissionMode = 'auto'
  await f.service.run(f.input)
  expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', code: 'claude_auto_unavailable' }))
})

describe('ExitPlanMode escalation', () => {
  const planFixture = async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'claude-plan-'))
    const planFile = path.join(cwd, '.ygg', 'plans', 'soft-gem.md')
    await mkdir(path.dirname(planFile), { recursive: true })
    await writeFile(planFile, '# Ship it\n\n1. Do the thing\n')
    const f = fixture([assistant('w', [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: planFile, content: '' } }]),
      assistant('x', [{ type: 'tool_use', id: 'exit', name: 'ExitPlanMode', input: {} }]), success])
    f.input.cwd = cwd
    f.input.request.operationMode = 'plan'
    await f.service.run(f.input)
    const options = f.sdk.query.mock.calls[0][0].options
    const exit = () => options.canUseTool('ExitPlanMode', {}, { signal: new AbortController().signal, toolUseID: 'exit' })
    return { f, options, exit, planFile: await realpath(planFile) }
  }

  it('stores native plans in plan_md storage', async () => {
    const { options } = await planFixture()
    expect(options.settings).toMatchObject({ plansDirectory: path.join('.ygg', 'plans') })
  })

  it('asks to switch to Agent mode with the plan attached, then lifts the Chat-mode tool policy', async () => {
    const { f, options, exit, planFile } = await planFixture()
    const decision = exit()
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'exit')).toBe(true))
    const prompt = f.emit.mock.calls.map(([event]) => event).find(event => event.type === 'operation_mode_upgrade_required')
    expect(prompt).toMatchObject({ toolCallId: 'exit', toolName: 'ExitPlanMode', toolInput: { plan: '# Ship it\n\n1. Do the thing\n', planFilePath: planFile } })
    const persisted = f.sink.updateAssistantToolState.mock.calls.at(-1)![1]
    expect(persisted.contentBlocks.find((block: any) => block.id === 'exit').input).toMatchObject({ plan: expect.stringContaining('# Ship it'), planFilePath: planFile })
    expect(f.broker.resolve('stream', 'exit', 'switch_to_execute')).toBe(true)
    await expect(decision).resolves.toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] })
    const edit = options.canUseTool('Edit', { file_path: 'a' }, { signal: new AbortController().signal, toolUseID: 'edit' })
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'edit')).toBe(true))
    f.broker.resolve('stream', 'edit', 'allow_once')
    await expect(edit).resolves.toMatchObject({ behavior: 'allow' })
  })

  it('keeps Chat mode without interrupting when the user stays in plan mode', async () => {
    const { f, options, exit } = await planFixture()
    const decision = exit()
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'exit')).toBe(true))
    f.broker.resolve('stream', 'exit', 'deny')
    const result = await decision
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(result.interrupt).toBeUndefined()
    await expect(options.canUseTool('Edit', {}, { signal: new AbortController().signal, toolUseID: 'edit' })).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('never reads plan paths outside the plans directory', async () => {
    const { f, options, planFile } = await planFixture()
    const outside = path.join(f.input.cwd, 'secret.md')
    await writeFile(outside, 'secret')
    const decision = options.canUseTool('ExitPlanMode', { planFilePath: outside }, { signal: new AbortController().signal, toolUseID: 'exit' })
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'exit')).toBe(true))
    const prompt = f.emit.mock.calls.map(([event]) => event).find(event => event.type === 'operation_mode_upgrade_required')
    // The out-of-root path is ignored; the plan Claude wrote this run remains the fallback.
    expect(prompt.toolInput).toMatchObject({ plan: expect.stringContaining('# Ship it'), planFilePath: planFile })
    f.broker.resolve('stream', 'exit', 'deny')
    await decision
  })
})

it('Allow all releases concurrent Claude permissions and auto-approves later calls', async () => {
  const f = fixture([assistant(), success])
  await f.service.run(f.input)
  const permission = f.sdk.query.mock.calls[0][0].options.canUseTool
  const call = (id: string) => permission('Bash', { command: 'echo hi' }, { signal: new AbortController().signal, toolUseID: id })
  const first = call('first')
  const second = call('second')
  expect(f.broker.hasPending('stream', 'first')).toBe(true)
  expect(f.broker.hasPending('stream', 'second')).toBe(true)
  expect(f.broker.resolve('stream', 'first', 'allow_always')).toBe(true)
  await expect(first).resolves.toMatchObject({ behavior: 'allow' })
  await expect(second).resolves.toMatchObject({ behavior: 'allow' })
  await expect(call('later')).resolves.toMatchObject({ behavior: 'allow' })
  expect(f.emit.mock.calls.filter(([event]) => event.type === 'permission_required')).toHaveLength(2)
  const stopped = new AbortController()
  stopped.abort()
  await expect(permission('Bash', {}, { signal: stopped.signal, toolUseID: 'stopped' })).resolves.toMatchObject({ behavior: 'deny', interrupt: true })
})
