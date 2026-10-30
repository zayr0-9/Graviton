import { describe, it, expect, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ClaudeSessionService, interruptedResumePoint, safeResumePoint } from '../claudeSessionService.js'
import { assertClaudeBranchSelection } from '../../persistence/claudeSessionRepo.js'
import { DecisionBroker } from '../decisionBroker.js'
import { createChatHookSession } from '../chatHookService.js'

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
  const hookRunStore = new Map<string, any>()
  const hookRuns = { create: vi.fn((record: any) => { hookRunStore.set(record.id, record); return record }),
    update: vi.fn((id: string, update: any) => { const next = { ...hookRunStore.get(id), ...update }; hookRunStore.set(id, next); return next }) }
  const input: any = { request: { conversationId: 'c', provider: 'Claude Code', modelName: 'claude-sonnet-5-5', content: 'hello', streamId: 'stream', operationMode: 'execute' },
    lineageId: 'l', userMessage: { id: 'u' }, parentId: 'u', sourceMessageId: null, fork: false, cwd: '/workspace', sink, emit }
  const service = new ClaudeSessionService({ sessions: sessions as any, messages: { get: vi.fn(() => null), updateClaudeProjection: vi.fn((id, content, contentBlocks, meta) => ({ id, content, content_blocks: contentBlocks, meta })) } as any, broker, executable: async () => '/mock/claude', sdk: async () => sdk as any, hookRuns })
  return { service, input, sdk, sessions, state, sink, rows, emit, broker, hookRunStore }
}
const assistant = (uuid = 'a', content: any[] = [{ type: 'text', text: 'answer' }]) => ({ type: 'assistant', uuid, session_id: 's', parent_tool_use_id: null, message: { content } })
const success = { type: 'result', subtype: 'success', is_error: false, session_id: 's' }

describe('Claude native session backend', () => {
  it('uses Claude tools and transcript, projects a completed response and records checkpoint', async () => {
    const f = fixture([assistant(), success])
    const final = await f.service.run(f.input)
    expect(final.content).toBe('answer')
    expect(final.meta.claude.checkpoint).toBe(true)
    expect(f.sdk.query.mock.calls[0][0].options).toMatchObject({ model: 'claude-sonnet-5-5', permissionMode: 'default', strictMcpConfig: true, persistSession: true,
      settingSources: ['user', 'project', 'local'], includeHookEvents: true })
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
  it('never disables thinking: a stale Off keeps the selected effort or the native default', async () => {
    for (const reasoningConfig of [{ effort: 'xhigh' }, undefined]) {
      const f = fixture([assistant(), success])
      f.input.request.think = false
      f.input.request.reasoningConfig = reasoningConfig
      await f.service.run(f.input)
      const options = f.sdk.query.mock.calls[0][0].options
      if (reasoningConfig) expect(options).toMatchObject({ thinking: { type: 'adaptive' }, effort: 'xhigh' })
      else expect(options).not.toHaveProperty('thinking')
    }
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
  it('requests summarized thinking with and without an explicit thinking config', async () => {
    for (const reasoningConfig of [{ effort: 'high' }, undefined]) {
      const f = fixture([assistant(), success])
      f.input.request.reasoningConfig = reasoningConfig
      await f.service.run(f.input)
      const options = f.sdk.query.mock.calls[0][0].options
      if (reasoningConfig) expect(options).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' } })
      else expect(options).toMatchObject({ extraArgs: { 'thinking-display': 'summarized' } })
    }
  })
  it('drops signature-only (omitted) thinking blocks from the projection', async () => {
    const f = fixture([{ ...assistant('thinking'), message: { id: 'api', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } },
      { ...assistant('text'), message: { id: 'api', content: [{ type: 'text', text: 'answer' }] } }, success])
    const final = await f.service.run(f.input)
    expect(final.content_blocks.map((block: any) => block.type)).toEqual(['text'])
  })
  it('merges partial Stop text into its existing response instead of making a second node', async () => {
    const f = fixture([{ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'api' } } },
      { ...assistant('thinking'), message: { id: 'api', content: [{ type: 'thinking', thinking: 'reason' }] } },
      { type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'unfinished' } } }])
    await expect(f.service.run(f.input)).rejects.toThrow('without a completed response')
    expect(f.sink.persistAssistantMessage).toHaveBeenCalledTimes(1)
    expect(f.emit.mock.calls.at(-1)?.[0]).toMatchObject({ message: { id: 'row0', content: 'unfinished', meta: { claude: { partial: true, checkpoint: false } } } })
  })
  it('reopens a live segment when a block starts after its API message was already persisted', async () => {
    const frame = (event: any) => ({ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event })
    const f = fixture([frame({ type: 'message_start', message: { id: 'api' } }),
      frame({ type: 'content_block_start', content_block: { type: 'thinking', thinking: '' } }),
      { ...assistant('thinking'), message: { id: 'api', content: [{ type: 'thinking', thinking: 'reason' }] } },
      frame({ type: 'content_block_start', content_block: { type: 'text', text: '' } }),
      frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }),
      { ...assistant('text'), message: { id: 'api', content: [{ type: 'text', text: 'answer' }] } }, success])
    await f.service.run(f.input)
    const events = f.emit.mock.calls.map(([event]) => event)
    const starts = events.flatMap((event, index) => event.type === 'tool_loop' && event.status === 'turn_started' ? [index] : [])
    expect(starts).toHaveLength(2)
    expect(events[starts[1]]).toMatchObject({ turn: 1 })
    const persisted = events.findIndex(event => event.type === 'assistant_message_persisted')
    const delta = events.findIndex(event => event.type === 'chunk' && event.part === 'text')
    expect(persisted).toBeLessThan(starts[1])
    expect(starts[1]).toBeLessThan(delta)
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
  it('keeps native Edit hunks on the tool_result without the original file', async () => {
    const hunk = { oldStart: 40, oldLines: 2, newStart: 40, newLines: 2, lines: [' keep', '-old', '+new'] }
    const f = fixture([assistant('tool-a', [{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'old', new_string: 'new' } }]),
      { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'updated' }] },
        tool_use_result: { filePath: '/w/a.ts', oldString: 'old', newString: 'new', originalFile: 'x'.repeat(5000), structuredPatch: [hunk], userModified: false, replaceAll: false } },
      assistant('final'), success])
    await f.service.run(f.input)
    const patch = { filePath: '/w/a.ts', kind: 'edit', hunks: [hunk] }
    expect(f.sink.updateAssistantToolState).toHaveBeenCalledWith('row0', expect.objectContaining({ contentBlocks: expect.arrayContaining([expect.objectContaining({ type: 'tool_result', tool_use_id: 't', patch })]) }))
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ part: 'tool_result', toolResult: expect.objectContaining({ patch }) }))
    expect(JSON.stringify(f.sink.updateAssistantToolState.mock.calls)).not.toContain('xxxxx')
  })
  it('does not attach a patch to non-file tools or failed edits', async () => {
    const toolUseResult = { filePath: '/w/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }
    const f = fixture([assistant('tool-a', [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }, { type: 'tool_use', id: 'e', name: 'Edit', input: {} }]),
      { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: 'text' }] }, tool_use_result: toolUseResult },
      { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: '<tool_use_error>no match</tool_use_error>', is_error: true }] }, tool_use_result: toolUseResult },
      assistant('final'), success])
    await f.service.run(f.input)
    const results = f.emit.mock.calls.map(([event]) => event).filter(event => event.part === 'tool_result')
    expect(results).toHaveLength(2)
    expect(results.every(event => !('patch' in event.toolResult))).toBe(true)
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
  it('inherits the provider, allows Claude model changes and rejects provider changes', () => {
    expect(() => assertClaudeBranchSelection(request, path)).not.toThrow()
    expect(() => assertClaudeBranchSelection({ ...request, modelName: 'other' }, path)).not.toThrow()
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
    expect(f.sdk.query.mock.calls[0][0].options.settings).toEqual({ plansDirectory: path.join('.ygg', 'plans') })
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

describe('Graviton chat hooks on native Claude tools', () => {
  const signal = () => new AbortController().signal
  function hooked(runHook: (req: any) => Promise<any>) {
    const f = fixture()
    const hookSession = createChatHookSession({ conversationRepo: { listMessageLineage: () => [] }, runHook, conversationId: 'c',
      cwd: '/workspace', provider: 'Claude Code', model: 'claude-sonnet-5-5', operation: 'send', streamId: 'stream' })
    f.input.hookSession = hookSession
    return f
  }
  const toolUse = (id: string) => assistant(`a-${id}`, [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }])

  it('runs Pre/Post hooks with Claude tool names, enforces deny and returns hook context to Claude', async () => {
    const requests: any[] = []
    const f = hooked(async req => {
      requests.push(req)
      if (req.event === 'PreToolUse' && req.toolCall.id === 'blocked') return { matched: true, hookCount: 1, permissionDecision: 'deny', permissionDecisionReason: 'no ls' }
      if (req.event === 'PreToolUse') return { matched: true, hookCount: 1, updatedInput: { command: 'ls -a' } }
      return { matched: true, hookCount: 1, additionalContext: `${req.event} context` }
    })
    const outputs: any[] = []
    f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      // A hook can arrive before the envelope that owns its tool_use.
      const early = options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'ok' }, 'ok', { signal: signal() })
      yield toolUse('ok')
      outputs.push(await early)
      outputs.push(await options.hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls -a' }, tool_response: { stdout: 'a' }, tool_use_id: 'ok' }, 'ok', { signal: signal() }))
      yield toolUse('blocked')
      outputs.push(await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'blocked' }, 'blocked', { signal: signal() }))
      outputs.push(await options.hooks.PostToolUseFailure[0].hooks[0]({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: {}, tool_use_id: 'blocked', error: 'boom' }, 'blocked', { signal: signal() }))
      // Child-agent tools and interrupts never reach Graviton hooks.
      outputs.push(await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', session_id: 's', agent_id: 'child', tool_name: 'Bash', tool_input: {}, tool_use_id: 'child' }, 'child', { signal: signal() }))
      outputs.push(await options.hooks.PostToolUseFailure[0].hooks[0]({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: {}, tool_use_id: 'blocked', error: 'stop', is_interrupt: true }, 'blocked', { signal: signal() }))
      outputs.push(await options.hooks.SessionStart[0].hooks[0]({ hook_event_name: 'SessionStart', session_id: 's', source: 'compact' }, undefined, { signal: signal() }))
      outputs.push(await options.hooks.SessionStart[0].hooks[0]({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' }, undefined, { signal: signal() }))
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    await f.service.run(f.input)
    expect(requests.map(req => [req.event, req.toolCall?.name ?? null, req.messageId])).toEqual([
      ['PreToolUse', 'Bash', 'row0'], ['PostToolUse', 'Bash', 'row0'], ['PreToolUse', 'Bash', 'row1'], ['PostToolUseFailure', 'Bash', 'row1'], ['SessionStart', null, null]])
    expect(requests[1].toolResult).toBe(JSON.stringify({ stdout: 'a' }))
    expect(outputs).toEqual([
      // A rewrite stays behind the host approval prompt.
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', updatedInput: { command: 'ls -a' } } },
      { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'PostToolUse context' } },
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no ls' } },
      { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'PostToolUseFailure context' } },
      {}, {},
      { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SessionStart context' } },
      {},
    ])
  })

  it('registers no tool hooks without a hook session', async () => {
    const f = fixture([assistant(), success])
    await f.service.run(f.input)
    expect(Object.keys(f.sdk.query.mock.calls[0][0].options.hooks).sort()).toEqual(['InstructionsLoaded', 'PostCompact', 'PreCompact'])
  })
})

describe('Claude Code skills and hooks', () => {
  const system = (subtype: string, fields: any) => ({ type: 'system', subtype, session_id: 's', uuid: `${subtype}-${fields.hook_id}`, ...fields })
  const user = (content: any, extra: any = {}) => ({ type: 'user', uuid: `user-${Math.random()}`, session_id: 's', parent_tool_use_id: null, message: { role: 'user', content }, ...extra })

  it('loads Claude Code settings, skills and hooks instead of isolating the session', async () => {
    const f = fixture([assistant(), success])
    await f.service.run(f.input)
    const options = f.sdk.query.mock.calls[0][0].options
    expect(options).toMatchObject({ settingSources: ['user', 'project', 'local'], includeHookEvents: true, strictMcpConfig: true, mcpServers: {} })
    expect(options.settings).not.toHaveProperty('disableAllHooks')
  })

  it('records native hooks as hook runs on the row that owns them', async () => {
    const f = fixture([
      system('hook_started', { hook_id: 'start', hook_name: 'SessionStart:startup', hook_event: 'SessionStart' }),
      system('hook_response', { hook_id: 'start', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', stdout: 'ready\n', stderr: '', output: 'ready\n', exit_code: 0, outcome: 'success' }),
      assistant('a-tool', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }]),
      system('hook_started', { hook_id: 'pre', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' }),
      system('hook_progress', { hook_id: 'pre', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', stdout: 'checking', stderr: '', output: 'checking' }),
      system('hook_response', { hook_id: 'pre', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', stdout: '', stderr: 'no rm -rf\n', output: 'no rm -rf\n', exit_code: 2, outcome: 'error' }),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'blocked', is_error: true }]),
      system('hook_started', { hook_id: 'lint', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse' }),
      system('hook_response', { hook_id: 'lint', hook_name: 'PostToolUse:Bash', hook_event: 'PostToolUse', stdout: '{"systemMessage":"lint clean"}', stderr: '', output: '', exit_code: 0, outcome: 'success' }),
      system('hook_started', { hook_id: 'crash', hook_name: 'Stop', hook_event: 'Stop' }),
      system('hook_response', { hook_id: 'crash', hook_name: 'Stop', hook_event: 'Stop', stdout: '', stderr: 'token=abc123 failed', output: '', exit_code: 1, outcome: 'error' }),
      system('hook_started', { hook_id: 'silent', hook_name: 'Notification', hook_event: 'Notification' }),
      assistant(), success])
    await f.service.run(f.input)
    const run = (id: string) => f.hookRunStore.get(id)
    expect(run('start')).toMatchObject({ event: 'SessionStart', label: 'SessionStart:startup', messageId: 'u', sourceFile: 'Claude Code',
      status: 'succeeded', outcomeCode: 'completed', stdoutPreview: 'ready\n', conversationId: 'c', streamId: 'stream' })
    // Exit 2 is Claude's deny: the hook worked, and its reason is the summary.
    expect(run('pre')).toMatchObject({ messageId: 'row0', status: 'succeeded', outcomeCode: 'blocked', outcomeSummary: 'no rm -rf', errorSummary: null })
    expect(run('lint')).toMatchObject({ messageId: 'row0', status: 'succeeded', outcomeSummary: 'lint clean' })
    expect(run('crash')).toMatchObject({ status: 'failed', outcomeCode: 'exit_1' })
    expect(run('crash').errorSummary).not.toContain('abc123')
    expect(run('silent')).toMatchObject({ status: 'skipped', outcomeCode: 'no_response' })
    const activity = f.emit.mock.calls.map(([event]) => event).filter(event => event.type === 'hook_activity')
    expect(activity.find(event => event.runs[0].id === 'pre' && event.runs[0].status === 'running')).toMatchObject({ messageId: 'row0', event: 'PreToolUse', lineageId: 'l' })
    expect(activity.filter(event => event.runs[0].id === 'pre').map(event => event.runs[0].stdoutPreview)).toContain('checking')
    expect(activity.every(event => event.messageId === event.runs[0].messageId)).toBe(true)
  })

  it('marks native hooks that were still running when the run stopped', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.input.signal = controller.signal
    f.sdk.query.mockImplementation(() => Object.assign((async function* () {
      yield system('hook_started', { hook_id: 'slow', hook_name: 'UserPromptSubmit', hook_event: 'UserPromptSubmit' })
      controller.abort()
      yield assistant()
    })(), { close: vi.fn() }) as any)
    await expect(f.service.run(f.input)).rejects.toThrow()
    expect(f.hookRunStore.get('slow')).toMatchObject({ messageId: 'u', status: 'failed', outcomeCode: 'interrupted' })
  })

  it('keeps the instructions a Skill call loaded on the row of that call', async () => {
    const f = fixture([
      // A synthetic message with no Skill call in flight is not a skill body.
      user([{ type: 'text', text: 'queued notice' }], { isSynthetic: true }),
      assistant('a-skill', [{ type: 'tool_use', id: 'k1', name: 'Skill', input: { skill: 'probe' } }]),
      user([{ type: 'tool_result', tool_use_id: 'k1', content: 'Launching skill: probe' }], { tool_use_result: { success: true, commandName: 'probe' } }),
      user([{ type: 'text', text: 'Base directory for this skill: /workspace/.claude/skills/probe\n\nSay PINEAPPLE.' }], { isSynthetic: true }),
      assistant('a-final', [{ type: 'text', text: 'PINEAPPLE' }]), success])
    await f.service.run(f.input)
    const blocks = f.sink.updateAssistantToolState.mock.calls.at(-1)![1].contentBlocks
    expect(blocks.map((block: any) => block.type)).toEqual(['tool_use', 'tool_result', 'context_injection'])
    expect(blocks[2]).toMatchObject({ tool_use_id: 'k1', path: path.join('/workspace/.claude/skills/probe', 'SKILL.md'),
      label: 'skill probe instructions', reason: 'skill', origin: 'claude' })
    expect(blocks[2].text).toContain('Say PINEAPPLE.')
    expect(f.rows.some(row => JSON.stringify(row.contentBlocks).includes('queued notice'))).toBe(false)
  })

  it('shows the instruction files Claude loads: startup on the first row, tool-triggered beside that result', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'claude-instructions-')))
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'CLAUDE.md'), 'Project rule.<!-- hidden -->\n')
    await writeFile(path.join(root, 'rule.md'), '---\npaths:\n  - "src/**"\n---\nPath rule.\n')
    await writeFile(path.join(root, 'empty.md'), '<!-- only a comment -->\n')
    const f = fixture()
    f.input.cwd = root
    const signal = new AbortController().signal
    const load = (fields: any) => f.sdk.query.mock.calls[0][0].options.hooks.InstructionsLoaded[0].hooks[0](
      { hook_event_name: 'InstructionsLoaded', session_id: 's', memory_type: 'Project', ...fields }, undefined, { signal })
    f.sdk.query.mockImplementation(() => Object.assign((async function* () {
      await load({ file_path: path.join(root, 'CLAUDE.md'), load_reason: 'session_start' })
      await load({ file_path: path.join(root, 'empty.md'), load_reason: 'session_start' })
      await load({ file_path: path.join(root, 'CLAUDE.md'), load_reason: 'session_start', agent_id: 'child' })
      yield assistant('a-tool', [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'src/app.ts' } }])
      await load({ file_path: path.join(root, 'rule.md'), load_reason: 'path_glob_match', trigger_file_path: path.join(root, 'src/app.ts') })
      // Already shown this run.
      await load({ file_path: path.join(root, 'CLAUDE.md'), load_reason: 'nested_traversal', trigger_file_path: path.join(root, 'src/app.ts') })
      yield user([{ type: 'tool_result', tool_use_id: 'r1', content: 'code' }])
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    await f.service.run(f.input)
    const tool = f.sink.updateAssistantToolState.mock.calls.at(-1)![1].contentBlocks
    expect(tool.map((block: any) => block.type)).toEqual(['tool_use', 'context_injection', 'tool_result', 'context_injection'])
    // Startup load (no trigger) on the first row; the empty file and the child-agent load are not shown.
    expect(tool[1]).toEqual({ type: 'context_injection', path: path.join(root, 'CLAUDE.md'), label: 'project instructions, checked into the codebase',
      text: 'Project rule.', reason: 'session_start', origin: 'claude', index: 1 })
    expect(tool[3]).toMatchObject({ tool_use_id: 'r1', path: path.join(root, 'rule.md'), text: 'Path rule.', reason: 'path_glob_match', origin: 'claude' })
  })

  it('does not show startup instructions again when a session resumes', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'claude-instructions-')))
    await writeFile(path.join(root, 'CLAUDE.md'), 'Project rule.\n')
    const f = fixture()
    f.input.cwd = root
    f.state.branch = { session_id: 's', state: 'ready' }
    f.state.checkpoint = { session_id: 's', message_uuid: 'checkpoint', cwd: root, resumable: 1 }
    f.input.sourceMessageId = 'tail'
    f.sdk.getSessionMessages.mockResolvedValue([{ uuid: 'checkpoint' }])
    f.sdk.query.mockImplementation(() => Object.assign((async function* () {
      const hook = f.sdk.query.mock.calls[0][0].options.hooks.InstructionsLoaded[0].hooks[0]
      await hook({ hook_event_name: 'InstructionsLoaded', session_id: 's', memory_type: 'Project', file_path: path.join(root, 'CLAUDE.md'), load_reason: 'session_start' },
        undefined, { signal: new AbortController().signal })
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    const final = await f.service.run(f.input)
    expect(f.sdk.query.mock.calls[0][0].options.resume).toBe('s')
    expect(final.content_blocks.some((block: any) => block.type === 'context_injection')).toBe(false)
  })

  it('passes a resolved native command through for Claude to expand', async () => {
    const f = fixture([assistant(), success])
    f.input.request.content = '/acme:deploy staging'
    f.input.nativeCommand = true
    await f.service.run(f.input)
    const { value } = await f.sdk.query.mock.calls[0][0].prompt.next()
    expect(value.message.content).toBe('/acme:deploy staging')
  })

  it('resolves only Claude skills and custom commands, never its built-ins', async () => {
    const f = fixture()
    const lookups: any[] = []
    f.sdk.query.mockImplementation(({ options }: any) => {
      const lookup = { options, close: vi.fn(), supportedCommands: vi.fn(async () => [
        { name: 'acme:deploy', description: 'Deploys the app (plugin)', argumentHint: '<env>', aliases: ['ship'] },
        { name: 'clear', description: 'Clear the conversation', argumentHint: '', builtin: true },
        // A name a built-in carries runs the built-in, whatever else shares it.
        { name: 'review', description: 'Project review', argumentHint: '' },
        { name: 'review', description: 'Built-in review', argumentHint: '', builtin: true },
      ]) }
      lookups.push(lookup)
      return lookup as any
    })
    expect(await f.service.nativeCommand('/workspace', '/acme:deploy staging now')).toEqual({ name: 'acme:deploy', args: 'staging now', description: 'Deploys the app (plugin)' })
    expect(await f.service.nativeCommand('/workspace', '/ship')).toMatchObject({ name: 'acme:deploy', args: '' })
    expect(await f.service.nativeCommand('/workspace', '/clear')).toBeNull()
    expect(await f.service.nativeCommand('/workspace', '/review')).toBeNull()
    expect(await f.service.nativeCommand('/workspace', '/missing')).toBeNull()
    expect(await f.service.nativeCommand('/workspace', 'not a command')).toBeNull()
    expect(lookups).toHaveLength(5)
    expect(lookups.every(lookup => lookup.close.mock.calls.length === 1)).toBe(true)
    expect(lookups[0].options).toMatchObject({ cwd: '/workspace', settingSources: ['user', 'project', 'local'], persistSession: false,
      settings: { disableAllHooks: true }, pathToClaudeCodeExecutable: '/mock/claude' })
  })

  it('shows Graviton compaction hooks on the summary they ran for', async () => {
    const runs: any[] = []
    const runHook = vi.fn(async (req: any) => {
      const record = { id: `${req.event}-run`, event: req.event, messageId: req.messageId ?? null, status: 'succeeded', updatedAt: new Date().toISOString() }
      runs.push(record)
      req.onActivity?.([record])
      return { matched: true, hookCount: 1 }
    })
    const f = fixture()
    const tracker = { create: vi.fn(), update: vi.fn((id: string, update: any) => ({ ...runs.find(run => run.id === id), ...update })) }
    f.input.hookSession = createChatHookSession({ conversationRepo: { listMessageLineage: () => [] }, runHook, conversationId: 'c',
      cwd: '/workspace', provider: 'Claude Code', model: 'claude-sonnet-5-5', operation: 'send', streamId: 'stream', emit: f.emit, runTracker: tracker as any })
    f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      const signal = new AbortController().signal
      await options.hooks.PreCompact[0].hooks[0]({ hook_event_name: 'PreCompact', session_id: 's', trigger: 'auto' }, undefined, { signal })
      await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'auto', compact_summary: 'state' }, undefined, { signal })
      yield { type: 'system', subtype: 'compact_boundary', session_id: 's' }
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    await f.service.run(f.input)
    expect(tracker.update).toHaveBeenCalledWith('PreCompact-run', { messageId: 'row0' })
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'hook_activity', event: 'PreCompact', messageId: 'row0' }))
  })
})

describe('Queued input on a live Claude session', () => {
  // The run's mailbox as the orchestrator exposes it; entries stay queued until Claude starts them.
  function mailbox() {
    const entries: Array<{ requestId: string; content: string; images: string[]; status: string; offered?: boolean }> = []
    let wake = () => {}
    let cancel: (requestId: string) => Promise<boolean | null> = async () => null
    const bridge = {
      subscribe: vi.fn((next: () => void) => { wake = next; return () => { wake = () => {} } }),
      prepareNext: vi.fn(async () => {
        const entry = entries.find(row => row.status === 'queued' && !row.offered)
        if (!entry) return null
        entry.offered = true
        return { requestId: entry.requestId, prompt: entry.content, images: entry.images }
      }),
      deliver: vi.fn((requestId: string, parentId: string | null) => {
        entries.find(row => row.requestId === requestId)!.status = 'delivered'
        return { id: `user-${requestId}`, parentId }
      }),
      release: vi.fn((requestId: string, outcome: any) => {
        entries.find(row => row.requestId === requestId)!.status = 'cancelled' in outcome ? 'cancelled' : 'failed'
      }),
      tryClose: vi.fn(() => !entries.some(row => row.status === 'queued')),
      bindCancel: vi.fn((next: typeof cancel) => { cancel = next }),
    }
    return { bridge, entries, cancel: (requestId: string) => cancel(requestId),
      add(requestId: string, content = requestId, images: string[] = []) { entries.push({ requestId, content, images, status: 'queued' }); wake() } }
  }
  // A CLI double that reads the service's input stream as the real one does.
  function scripted(f: ReturnType<typeof fixture>, script: (read: () => Promise<IteratorResult<any>>) => AsyncGenerator<any>, cancelAsyncMessage = vi.fn(async () => true)) {
    f.sdk.query.mockImplementation(({ prompt }: any) => {
      const input = prompt[Symbol.asyncIterator]()
      return Object.assign(script(() => input.next()), { close: vi.fn(), cancelAsyncMessage }) as any
    })
    return cancelAsyncMessage
  }
  const toolUse = (uuid: string) => assistant(uuid, [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }])
  const toolResult = { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'one' }] } }
  const lifecycle = (uuid: string, state: string) => ({ type: 'command_lifecycle', command_uuid: uuid, state, session_id: 's' })

  it('sends a queued message at priority next and parents the rest of the turn on its user row', async () => {
    const f = fixture(); const q = mailbox(); f.input.queuedInput = q.bridge
    const sent: any[] = []
    scripted(f, async function* (read) {
      sent.push((await read()).value)
      yield toolUse('a1')
      q.add('r1', 'also PURPLE')
      const queued = (await read()).value
      sent.push(queued)
      yield lifecycle(queued.uuid, 'queued')
      yield toolResult
      yield lifecycle(queued.uuid, 'started')
      yield assistant('a2', [{ type: 'text', text: 'DONE PURPLE' }])
      yield success
      sent.push(await read())
    })
    const final = await f.service.run(f.input)
    expect(sent[1]).toMatchObject({ type: 'user', priority: 'next', parent_tool_use_id: null, message: { role: 'user', content: 'also PURPLE' } })
    expect(q.bridge.deliver).toHaveBeenCalledWith('r1', 'row0')
    expect(f.rows[1].parentId).toBe('user-r1')
    expect(final.content).toBe('DONE PURPLE')
    expect(f.sessions.record).toHaveBeenLastCalledWith(final.id, 's', 'a2', '/workspace', true)
    // Nothing left queued: input closes after the result.
    expect(sent[2]).toEqual({ done: true, value: undefined })
  })

  it('keeps the session open after a result while Claude still holds a queued message', async () => {
    const f = fixture(); const q = mailbox(); f.input.queuedInput = q.bridge
    let results = 0
    scripted(f, async function* (read) {
      await read()
      yield assistant('a1', [{ type: 'text', text: 'first' }])
      q.add('r1')
      const queued = (await read()).value
      yield success; results++
      yield lifecycle(queued.uuid, 'started')
      yield assistant('a2', [{ type: 'text', text: 'second' }])
      yield success; results++
      expect((await read()).done).toBe(true)
    })
    const final = await f.service.run(f.input)
    expect(results).toBe(2)
    expect(q.bridge.deliver).toHaveBeenCalledWith('r1', 'row0')
    expect(final).toMatchObject({ content: 'second' })
    expect(f.rows[1].parentId).toBe('user-r1')
    expect(f.sessions.record).toHaveBeenLastCalledWith(final.id, 's', 'a2', '/workspace', true)
  })

  it('withdraws a message Claude holds but has not started', async () => {
    const f = fixture(); const q = mailbox(); f.input.queuedInput = q.bridge
    let outcome: boolean | null | undefined
    const cancelAsyncMessage = scripted(f, async function* (read) {
      await read()
      yield toolUse('a1')
      q.add('r1')
      const queued = (await read()).value
      outcome = await q.cancel('r1')
      expect(cancelAsyncMessage).toHaveBeenCalledWith(queued.uuid)
      yield toolResult
      yield assistant('a2'); yield success
      expect((await read()).done).toBe(true)
    })
    await f.service.run(f.input)
    expect(outcome).toBe(true)
    expect(q.bridge.release).toHaveBeenCalledWith('r1', { cancelled: true })
    expect(q.bridge.deliver).not.toHaveBeenCalled()
  })

  it('reports a message Claude already started as not cancellable, and an unoffered one as local', async () => {
    const f = fixture(); const q = mailbox(); f.input.queuedInput = q.bridge
    const outcomes: Array<boolean | null> = []
    scripted(f, async function* (read) {
      await read()
      outcomes.push(await q.cancel('missing'))
      yield toolUse('a1')
      q.add('r1')
      const queued = (await read()).value
      yield toolResult
      yield lifecycle(queued.uuid, 'started')
      outcomes.push(await q.cancel('r1'))
      yield assistant('a2'); yield success
    }, vi.fn(async () => false))
    await f.service.run(f.input)
    expect(outcomes).toEqual([null, false])
    expect(q.bridge.release).not.toHaveBeenCalled()
  })

  it('fails a queued message whose image Claude cannot read, without sending it', async () => {
    const f = fixture(); const q = mailbox(); f.input.queuedInput = q.bridge
    const sent: any[] = []
    scripted(f, async function* (read) {
      await read()
      yield toolUse('a1')
      q.add('r1', 'look', ['data:image/bmp;base64,AAAA'])
      await new Promise(resolve => setTimeout(resolve, 0))
      yield toolResult
      yield assistant('a2'); yield success
      sent.push(await read())
    })
    await f.service.run(f.input)
    expect(q.bridge.release).toHaveBeenCalledWith('r1', { error: 'Claude accepts PNG, JPEG, GIF or WebP images only.' })
    expect(sent).toEqual([{ done: true, value: undefined }])
  })

  it.skipIf(process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1')('live service: folds, defers and withdraws queued messages on the real CLI', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const native = await import('@anthropic-ai/claude-agent-sdk')
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-queue-'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 220_000)
    const live = (content: string, onEvent: (event: any, q: ReturnType<typeof mailbox>) => void) => {
      const f = fixture(); const q = mailbox()
      f.broker.initSession('stream', { autoApproveAll: true })
      Object.assign(f.input, { cwd, signal: controller.signal, queuedInput: q.bridge })
      Object.assign(f.input.request, { modelName: 'claude-haiku-5-5', content })
      f.sdk.query.mockImplementation((args: any) => native.query({ ...args, options: { ...args.options,
        pathToClaudeCodeExecutable: process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude'), tools: ['Bash'] } }) as any)
      f.input.emit = (event: any) => { f.emit(event); onEvent(event, q) }
      return { f, q }
    }
    const twoTools = 'Use Bash to run `sleep 4 && echo one`. After it finishes, use Bash to run `sleep 4 && echo two`. Then reply with DONE and nothing else.'
    const once = (fn: (q: ReturnType<typeof mailbox>) => void) => { let done = false; return (q: ReturnType<typeof mailbox>) => { if (!done) { done = true; fn(q) } } }
    try {
      // Mid-turn: Claude reads the message at its next tool boundary, in the same turn.
      const addDuringTool = once(q => q.add('r1', 'Also include the word PURPLE in your final reply.'))
      const fold = live(twoTools, (event, q) => { if (event.type === 'tool_execution' && event.status === 'started') addDuringTool(q) })
      const folded = await fold.f.service.run(fold.f.input)
      expect(fold.q.bridge.deliver).toHaveBeenCalledOnce()
      expect(folded.content).toContain('PURPLE')
      const user = fold.q.bridge.deliver.mock.results[0].value
      expect(fold.f.rows.find(row => row.parentId === user.id)).toBeTruthy()
      const [, session] = fold.f.sessions.record.mock.calls.at(-1)!
      const transcript = await native.getSessionMessages(session, { dir: cwd })
      expect(transcript.some(entry => entry.type === 'user' && JSON.stringify(entry.message).includes('PURPLE'))).toBe(true)

      // No tool boundary left: the message runs as its own turn after the result.
      const addDuringText = once(q => q.add('r2', 'Now reply with only the word PURPLE.'))
      const defer = live('Write two sentences about lighthouses. Do not use tools.', (event, q) => {
        if (event.type === 'chunk' && event.part === 'text') addDuringText(q)
      })
      const deferred = await defer.f.service.run(defer.f.input)
      expect(defer.q.bridge.deliver).toHaveBeenCalledOnce()
      expect(deferred.content).toContain('PURPLE')
      expect(defer.f.rows.at(-1)!.parentId).toBe(defer.q.bridge.deliver.mock.results[0].value.id)

      // Withdrawn while Claude holds it: Claude never reads it.
      let withdrawal: Promise<boolean | null> | undefined
      const addThenCancel = once(q => {
        q.add('r3', 'Also include the word PURPLE in your final reply.')
        withdrawal = (async () => {
          while (!q.entries[0].offered) await new Promise(resolve => setTimeout(resolve, 20))
          await new Promise(resolve => setTimeout(resolve, 300))
          return q.cancel('r3')
        })()
      })
      const cancel = live(twoTools, (event, q) => { if (event.type === 'tool_execution' && event.status === 'started') addThenCancel(q) })
      const kept = await cancel.f.service.run(cancel.f.input)
      expect(await withdrawal).toBe(true)
      expect(cancel.q.bridge.release).toHaveBeenCalledWith('r3', { cancelled: true })
      expect(cancel.q.bridge.deliver).not.toHaveBeenCalled()
      expect(kept.content).not.toContain('PURPLE')
    } finally { clearTimeout(timer); controller.abort(); await rm(cwd, { recursive: true, force: true }) }
  }, 240_000)

  it('reports a withdrawal as cancelled when the CLI frame arrives before the cancel answer', async () => {
    const f = fixture(); const q = mailbox(); f.input.queuedInput = q.bridge
    let outcome: Promise<boolean | null> | undefined
    let answer!: (value: boolean) => void
    scripted(f, async function* (read) {
      await read()
      yield toolUse('a1')
      q.add('r1')
      const queued = (await read()).value
      outcome = q.cancel('r1')
      yield lifecycle(queued.uuid, 'cancelled')
      answer(true)
      yield toolResult
      yield assistant('a2'); yield success
      expect((await read()).done).toBe(true)
    }, vi.fn(() => new Promise<boolean>(resolve => { answer = resolve })))
    await f.service.run(f.input)
    expect(await outcome).toBe(true)
    expect(q.bridge.release).toHaveBeenCalledOnce()
    expect(q.bridge.release).toHaveBeenCalledWith('r1', { cancelled: true })
  })

  it('treats a native cancel of a held message as cancelled', async () => {
    const f = fixture(); const q = mailbox(); f.input.queuedInput = q.bridge
    scripted(f, async function* (read) {
      await read()
      yield toolUse('a1')
      q.add('r1')
      const queued = (await read()).value
      yield lifecycle(queued.uuid, 'cancelled')
      yield toolResult
      yield assistant('a2'); yield success
      expect((await read()).done).toBe(true)
    })
    await f.service.run(f.input)
    expect(q.bridge.release).toHaveBeenCalledWith('r1', { cancelled: true })
  })
})
