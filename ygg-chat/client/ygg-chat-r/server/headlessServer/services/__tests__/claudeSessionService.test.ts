import { describe, it, expect, vi } from 'vitest'
import { ClaudeSessionService } from '../claudeSessionService.js'
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
  const service = new ClaudeSessionService({ sessions: sessions as any, messages: { updateClaudeProjection: vi.fn((id, content, contentBlocks, meta) => ({ id, content, content_blocks: contentBlocks, meta })) } as any, broker, executable: async () => '/mock/claude', sdk: async () => sdk as any })
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
    f.sdk.getSessionMessages.mockResolvedValue([])
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
  } finally { clearTimeout(timer); controller.abort(); await rm(cwd, { recursive: true, force: true }) }
}, 120_000)
