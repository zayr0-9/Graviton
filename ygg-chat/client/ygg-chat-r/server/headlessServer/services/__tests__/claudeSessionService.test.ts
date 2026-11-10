import { describe, it, expect, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CHAT_MODE_NOTE, ClaudeSessionService, PLAN_MODE_NOTE, isClaudePlanFile, claudeModeSwitchNotice, interruptedResumePoint, parseClaudeSlashCommand, safeResumePoint, type ClaudeTaskControl } from '../claudeSessionService.js'
import { OperationModeControl } from '../operationModeControl.js'
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
    // The blocks are the only stored copy: no legacy tool_calls, so no duplicated result.
    for (const [, update] of f.sink.updateAssistantToolState.mock.calls) expect(update.toolCalls).toBeUndefined()
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
      yield { type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }
      await options.hooks.PreCompact[0].hooks[0]({ hook_event_name: 'PreCompact', session_id: 's', trigger }, undefined, { signal: new AbortController().signal })
      await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger, compact_summary: 'Portable task state' }, undefined, { signal: new AbortController().signal })
      yield { type: 'system', subtype: 'compact_boundary', session_id: 's' }
      if (trigger === 'auto') yield assistant('after')
      yield success
    })(), { close: vi.fn() }) as any)
    const final = await f.service.run(f.input)
    expect(f.rows[0]).toMatchObject({ content: 'Portable task state', parentId: 'u', statisticsKind: 'compaction_summary', meta: { kind: 'compaction_summary', state: 'committed', trigger } })
    const statuses = f.emit.mock.calls.map(([event]) => event).filter(event => event.type === 'context_compaction').map(event => event.status)
    expect(statuses).toEqual(['started', 'completed'])
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
  it('records a mode switch made during manual /compact on the summary', async () => {
    const f = fixture()
    const control = new OperationModeControl('execute')
    Object.assign(f.input, { modeControl: control })
    f.input.request.manualCompaction = true
    f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'manual', compact_summary: 'Portable task state' }, undefined, { signal: new AbortController().signal })
      yield { type: 'system', subtype: 'compact_boundary', session_id: 's' }
      control.change('plan', 'm1')
      yield success
    })(), { close: vi.fn() }) as any)
    const final = await f.service.run(f.input)
    expect(f.rows[0].meta).toMatchObject({ kind: 'compaction_summary', operationMode: 'execute' })
    expect(final).toMatchObject({ id: 'row0', content: 'Portable task state', meta: { kind: 'compaction_summary', state: 'committed', operationMode: 'plan' } })
    expect(control.hasPending).toBe(false)
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
  it('does not show a background agent compaction as the main chat compacting', async () => {
    // CLI 2.1.318 sends a subagent's PreCompact with the parent's session and no agent_id, and
    // emits neither a status event nor PostCompact for it on the main stream.
    const f = fixture()
    f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      await options.hooks.PreCompact[0].hooks[0]({ hook_event_name: 'PreCompact', session_id: 's', trigger: 'auto' }, undefined, { signal: new AbortController().signal })
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    await f.service.run(f.input)
    expect(f.emit.mock.calls.some(([event]) => event.type === 'context_compaction')).toBe(false)
    expect(f.rows.map(row => row.content)).toEqual(['answer'])
  })
  it('starts the main compaction once across repeated status heartbeats', async () => {
    const f = fixture()
    f.sdk.query.mockImplementation(({ options }: any) => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      yield { type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }
      yield { type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }
      await options.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', session_id: 's', trigger: 'auto', compact_summary: 'state' }, undefined, { signal: new AbortController().signal })
      yield { type: 'system', subtype: 'compact_boundary', session_id: 's' }
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    await f.service.run(f.input)
    const statuses = f.emit.mock.calls.map(([event]) => event).filter(event => event.type === 'context_compaction').map(event => event.status)
    expect(statuses).toEqual(['started', 'completed'])
  })
  it('clears a main compaction indicator the turn ended without settling', async () => {
    const f = fixture()
    f.sdk.query.mockImplementation(() => Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' }
      yield { type: 'system', subtype: 'status', status: 'compacting', session_id: 's' }
      yield assistant(); yield success
    })(), { close: vi.fn() }) as any)
    await f.service.run(f.input)
    const events = f.emit.mock.calls.map(([event]) => event).filter(event => event.type === 'context_compaction')
    expect(events.map(event => event.status)).toEqual(['started', 'failed'])
    expect(events[1].error).toBe('Claude compaction did not complete')
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

it('reads slash input with the Claude Code command-name grammar', () => {
  expect(parseClaudeSlashCommand('/acme:deploy staging now')).toEqual({ name: 'acme:deploy', args: 'staging now' })
  expect(parseClaudeSlashCommand('  /compact\n')).toEqual({ name: 'compact', args: '' })
  // Claude Code sends these to the model as prose, so they are not commands.
  expect(parseClaudeSlashCommand('/Users/me/plan.md\n\nport the tools')).toBeNull()
  expect(parseClaudeSlashCommand('/plan.md review it')).toBeNull()
  expect(parseClaudeSlashCommand('/')).toBeNull()
  expect(parseClaudeSlashCommand('not a command')).toBeNull()
})

it('sends a prompt that starts with a path as an ordinary prompt', async () => {
  const f = fixture([assistant(), success])
  f.input.request.content = '/Users/me/plan.md\n\nport the tools'
  await f.service.run(f.input)
  const { value } = await f.sdk.query.mock.calls[0][0].prompt.next()
  expect(value.message.content).toBe('/Users/me/plan.md\n\nport the tools')
})

it.each(['execute', 'plan'])('honors stream auto-approval in %s without SDK permission bypass', async operationMode => {
  const f = fixture([assistant(), success])
  f.input.request.operationMode = operationMode
  f.broker.initSession('stream', { autoApproveAll: true })
  await f.service.run(f.input)
  const options = f.sdk.query.mock.calls[0][0].options
  expect(options.permissionMode).toBe('default')
  // The tool list is the same in both modes: removing tools would break Claude's prompt cache on a mode switch.
  expect(options.disallowedTools).toBeUndefined()
  expect(options.allowDangerouslySkipPermissions).not.toBe(true)
  const { value } = await f.sdk.query.mock.calls[0][0].prompt.next()
  expect(value.message.content).toBe(operationMode === 'plan' ? `hello\n\n${CHAT_MODE_NOTE}` : 'hello')
  // The hook outranks Claude's own allow rules, acceptEdits and auto mode, child agents included.
  // Registered in both modes: a live switch can turn Chat mode on mid-run.
  const guard = options.hooks.PreToolUse.at(-1).hooks[0]
  for (const [tool_name, agent_id] of [['Write'], ['Edit', 'child'], ['NotebookEdit'], ['EnterPlanMode'], ['Bash'], ['TodoWrite'], ['ExitPlanMode']]) {
    const output = await guard({ hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input: {}, tool_use_id: tool_name, ...(agent_id ? { agent_id } : {}) },
      tool_name, { signal: new AbortController().signal })
    const blocked = operationMode === 'plan' && ['Write', 'Edit', 'NotebookEdit', 'EnterPlanMode'].includes(tool_name)
    expect(output.hookSpecificOutput?.permissionDecision).toBe(blocked ? 'deny' : undefined)
  }
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
    const control = new OperationModeControl('plan')
    f.input.modeControl = control
    await f.service.run(f.input)
    const options = f.sdk.query.mock.calls[0][0].options
    const exit = () => options.canUseTool('ExitPlanMode', {}, { signal: new AbortController().signal, toolUseID: 'exit' })
    return { f, options, exit, control, planFile: await realpath(planFile) }
  }

  it('stores native plans in plan_md storage', async () => {
    const { options } = await planFixture()
    expect(options.settings).toMatchObject({ plansDirectory: path.join('.ygg', 'plans') })
  })

  it('asks to switch to Agent mode with the plan attached, then lifts the Chat-mode tool policy', async () => {
    const { f, options, exit, control, planFile } = await planFixture()
    const decision = exit()
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'exit')).toBe(true))
    const prompt = f.emit.mock.calls.map(([event]) => event).find(event => event.type === 'operation_mode_upgrade_required')
    expect(prompt).toMatchObject({ toolCallId: 'exit', toolName: 'ExitPlanMode', toolInput: { plan: '# Ship it\n\n1. Do the thing\n', planFilePath: planFile } })
    const persisted = f.sink.updateAssistantToolState.mock.calls.at(-1)![1]
    expect(persisted.contentBlocks.find((block: any) => block.id === 'exit').input).toMatchObject({ plan: expect.stringContaining('# Ship it'), planFilePath: planFile })
    expect(f.broker.resolve('stream', 'exit', 'switch_to_execute')).toBe(true)
    await expect(decision).resolves.toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] })
    // The run's shared control flips, so a queued successor run and the composer see Agent mode too.
    expect(control.mode).toBe('execute')
    // The Chat-mode guard reads the live mode, so edits unblock for the rest of this run.
    await expect(options.hooks.PreToolUse.at(-1).hooks[0]({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Edit', tool_input: {}, tool_use_id: 'edit' },
      'edit', { signal: new AbortController().signal })).resolves.toEqual({})
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

describe('native plan mode', () => {
  const nativePlanFixture = async (operationMode: 'plan' | 'execute') => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'claude-native-plan-'))
    await mkdir(path.join(cwd, '.ygg', 'plans'), { recursive: true })
    const f = fixture([assistant(), success])
    f.input.cwd = cwd
    f.input.request.operationMode = operationMode
    f.input.request.claudePlanMode = true
    const control = new OperationModeControl(operationMode)
    f.input.modeControl = control
    await f.service.run(f.input)
    const options = f.sdk.query.mock.calls[0][0].options
    const guard = (tool_name: string, tool_input: Record<string, unknown> = {}) => options.hooks.PreToolUse.at(-1).hooks[0](
      { hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input, tool_use_id: tool_name }, tool_name, { signal: new AbortController().signal })
    const exit = () => options.canUseTool('ExitPlanMode', { plan: '# Plan' }, { signal: new AbortController().signal, toolUseID: 'exit' })
    return { f, cwd, options, guard, exit, control }
  }

  it.each(['plan', 'execute'] as const)('runs the CLI in plan mode in %s mode and lets Claude write only its plan file', async operationMode => {
    const { f, cwd, options, guard } = await nativePlanFixture(operationMode)
    expect(options.permissionMode).toBe('plan')
    // The tool list stays the same: plan mode must not change the cached prefix either.
    expect(options.disallowedTools).toBeUndefined()
    const { value } = await f.sdk.query.mock.calls[0][0].prompt.next()
    expect(value.message.content).toBe(`hello\n\n${PLAN_MODE_NOTE}`)
    await expect(guard('Write', { file_path: path.join(cwd, '.ygg', 'plans', 'soft-gem.md') })).resolves.toEqual({})
    await expect(guard('Edit', { file_path: '.ygg/plans/soft-gem.md' })).resolves.toEqual({})
    for (const file_path of ['src/app.ts', '.ygg/plans/notes.txt', '.ygg/plans/../escape.md', path.join(cwd, 'plan.md')]) {
      expect((await guard('Write', { file_path })).hookSpecificOutput?.permissionDecision).toBe('deny')
    }
    expect((await guard('NotebookEdit', { notebook_path: '.ygg/plans/a.md' })).hookSpecificOutput?.permissionDecision).toBe('deny')
    // Claude is already in plan mode; it cannot enter it again on its own.
    expect((await guard('EnterPlanMode')).hookSpecificOutput?.permissionDecisionReason).toMatch(/user's request/)
    await expect(guard('Read', { file_path: 'src/app.ts' })).resolves.toEqual({})
    // The permission callback backs the hook up, even with Allow all.
    await expect(options.canUseTool('Write', { file_path: 'src/app.ts' }, { signal: new AbortController().signal, toolUseID: 'w' }))
      .resolves.toMatchObject({ behavior: 'deny' })
  })

  it('refuses a plan path that a symlink leads out of the plans directory', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'claude-plan-link-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'claude-plan-outside-'))
    const plansDir = path.join(cwd, '.ygg', 'plans')
    await mkdir(plansDir, { recursive: true })
    await symlink(outside, path.join(plansDir, 'link'))
    await writeFile(path.join(outside, 'existing.md'), 'x')
    await expect(isClaudePlanFile(plansDir, cwd, '.ygg/plans/link/new.md')).resolves.toBe(false)
    await expect(isClaudePlanFile(plansDir, cwd, '.ygg/plans/link/existing.md')).resolves.toBe(false)
    await expect(isClaudePlanFile(plansDir, cwd, '.ygg/plans/sub/new.md')).resolves.toBe(true)
    await expect(isClaudePlanFile(plansDir, cwd, undefined)).resolves.toBe(false)
  })

  it('asks the user to approve the plan even in Agent mode, then lifts the plan-mode block', async () => {
    const { f, guard, exit, control } = await nativePlanFixture('execute')
    const decision = exit()
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'exit')).toBe(true))
    expect(f.emit.mock.calls.some(([event]) => event.type === 'operation_mode_upgrade_required' && event.toolName === 'ExitPlanMode')).toBe(true)
    f.broker.resolve('stream', 'exit', 'switch_to_execute')
    await expect(decision).resolves.toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] })
    expect(control.mode).toBe('execute')
    await expect(guard('Edit', { file_path: 'src/app.ts' })).resolves.toEqual({})
  })

  it('switches Chat mode to Agent mode when the user approves the plan', async () => {
    const { f, guard, exit, control } = await nativePlanFixture('plan')
    const decision = exit()
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'exit')).toBe(true))
    f.broker.resolve('stream', 'exit', 'switch_to_execute')
    await expect(decision).resolves.toMatchObject({ behavior: 'allow' })
    expect(control.mode).toBe('execute')
    await expect(guard('Write', { file_path: 'src/app.ts' })).resolves.toEqual({})
  })

  it('keeps planning when the user does not approve the plan', async () => {
    const { f, guard, exit, control } = await nativePlanFixture('execute')
    const decision = exit()
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'exit')).toBe(true))
    f.broker.resolve('stream', 'exit', 'deny')
    await expect(decision).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('keep planning') })
    expect(control.mode).toBe('execute')
    expect((await guard('Edit', { file_path: 'src/app.ts' })).hookSpecificOutput?.permissionDecision).toBe('deny')
  })

  it('takes precedence over auto mode', async () => {
    const f = fixture([assistant(), success])
    f.input.request.claudePermissionMode = 'auto'
    f.input.request.claudePlanMode = true
    await f.service.run(f.input)
    expect(f.sdk.query.mock.calls[0][0].options.permissionMode).toBe('plan')
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

  it('registers no Graviton tool hooks without a hook session, only the Chat-mode guard', async () => {
    const f = fixture([assistant(), success])
    await f.service.run(f.input)
    const hooks = f.sdk.query.mock.calls[0][0].options.hooks
    expect(Object.keys(hooks).sort()).toEqual(['InstructionsLoaded', 'PostCompact', 'PreCompact', 'PreToolUse'])
    expect(hooks.PreToolUse).toHaveLength(1)
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
    expect(await f.service.nativeCommand('/workspace', '/Users/me/plan.md port it')).toBeNull()
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
      deliver: vi.fn((requestId: string, parentId: string | null, _mode?: any) => {
        entries.find(row => row.requestId === requestId)!.status = 'delivered'
        return { id: `user-${requestId}`, parentId }
      }),
      recordModeSwitch: vi.fn((modeSwitch: any, parentId: string | null) => ({ id: `mode-${modeSwitch.mode}`, parentId })),
      release: vi.fn((requestId: string, outcome: any) => {
        entries.find(row => row.requestId === requestId)!.status = 'cancelled' in outcome ? 'cancelled' : 'failed'
      }),
      tryClose: vi.fn(() => !entries.some(row => row.status === 'queued')),
      bindCancel: vi.fn((next: typeof cancel) => { cancel = next }),
    }
    return { bridge, entries, cancel: (requestId: string) => cancel(requestId),
      add(requestId: string, content = requestId, images: string[] = []) { entries.push({ requestId, content, images, status: 'queued' }); wake() },
      // The mode route wakes the session after a live switch.
      poke: () => wake() }
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
    expect(q.bridge.deliver).toHaveBeenCalledWith('r1', 'row0', { mode: 'execute', planMode: false, modeSwitch: null })
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
    expect(q.bridge.deliver).toHaveBeenCalledWith('r1', 'row0', { mode: 'execute', planMode: false, modeSwitch: null })
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

  describe('live mode switches', () => {
    const guardOf = (f: ReturnType<typeof fixture>) => (f.sdk.query.mock.calls as any[])[0][0].options.hooks.PreToolUse.at(-1).hooks[0]
    const preToolUse = (tool_name: string) => [{ hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input: {}, tool_use_id: tool_name },
      tool_name, { signal: new AbortController().signal }]
    const live = (mode: 'plan' | 'execute') => {
      const f = fixture(); const q = mailbox(); const control = new OperationModeControl(mode)
      f.input.request.operationMode = mode
      Object.assign(f.input, { queuedInput: q.bridge, modeControl: control })
      return { f, q, control }
    }

    it('applies a switch to the next tool call and tells Claude at the running tool\'s boundary', async () => {
      const { f, q, control } = live('execute')
      let notice: any
      let write: any
      scripted(f, async function* (read) {
        await read()
        yield toolUse('a1')
        control.change('plan', 'switch'); q.poke()
        notice = (await read()).value
        write = await guardOf(f)(...preToolUse('Write'))
        yield lifecycle(notice.uuid, 'queued')
        yield toolResult
        yield lifecycle(notice.uuid, 'started')
        yield assistant('a2', [{ type: 'text', text: 'ok' }])
        yield success
        expect((await read()).done).toBe(true)
      })
      const final = await f.service.run(f.input)
      expect(notice).toMatchObject({ priority: 'next', parent_tool_use_id: null, message: { role: 'user', content: claudeModeSwitchNotice('plan') } })
      expect(write.hookSpecificOutput.permissionDecision).toBe('deny')
      // Recorded where Claude read it; the rest of the turn continues below the mode row.
      expect(q.bridge.recordModeSwitch).toHaveBeenCalledWith({ mode: 'plan', previousMode: 'execute', revision: 1, content: claudeModeSwitchNotice('plan') }, 'row0')
      expect(f.rows[1].parentId).toBe('mode-plan')
      expect(final.meta.operationMode).toBe('plan')
    })

    it('holds a switch while no tool runs and carries it on the next queued message', async () => {
      const { f, q, control } = live('execute')
      let queued: any
      scripted(f, async function* (read) {
        await read()
        yield assistant('a1', [{ type: 'text', text: 'first' }])
        control.change('plan', 'switch'); q.poke()
        await new Promise(resolve => setTimeout(resolve, 0))
        q.add('r1', 'next question')
        queued = (await read()).value
        yield success
        yield lifecycle(queued.uuid, 'started')
        yield assistant('a2', [{ type: 'text', text: 'second' }])
        yield success
        expect((await read()).done).toBe(true)
      })
      await f.service.run(f.input)
      // Nothing went out alone (it would have started a turn of its own): the switch rode on the message.
      expect(queued.message.content).toBe(`next question\n\n${claudeModeSwitchNotice('plan')}`)
      expect(q.bridge.recordModeSwitch).not.toHaveBeenCalled()
      expect(q.bridge.deliver).toHaveBeenCalledWith('r1', 'row0',
        { mode: 'plan', planMode: false, modeSwitch: { mode: 'plan', previousMode: 'execute', revision: 1, content: claudeModeSwitchNotice('plan') } })
    })

    it('adds the Chat-mode note to queued messages in Chat mode', async () => {
      const { f, q } = live('plan')
      let queued: any
      scripted(f, async function* (read) {
        await read()
        yield toolUse('a1')
        q.add('r1', 'and this')
        queued = (await read()).value
        yield toolResult
        yield lifecycle(queued.uuid, 'started')
        yield assistant('a2'); yield success
      })
      await f.service.run(f.input)
      expect(queued.message.content).toBe(`and this\n\n${CHAT_MODE_NOTE}`)
      expect(q.bridge.deliver).toHaveBeenCalledWith('r1', 'row0', { mode: 'plan', planMode: false, modeSwitch: null })
    })

    it('records a switch Claude never read on the final response, not as a row after it', async () => {
      const { f, q, control } = live('plan')
      const sent: any[] = []
      scripted(f, async function* (read) {
        sent.push((await read()).value)
        yield assistant('a1', [{ type: 'text', text: 'the answer' }])
        control.change('execute', 'switch'); q.poke()
        await new Promise(resolve => setTimeout(resolve, 0))
        yield success
        sent.push(await read())
      })
      const final = await f.service.run(f.input)
      expect(sent[0].message.content).toBe(`hello\n\n${CHAT_MODE_NOTE}`)
      expect(sent[1]).toEqual({ done: true, value: undefined })
      expect(q.bridge.recordModeSwitch).not.toHaveBeenCalled()
      expect(final.meta.operationMode).toBe('execute')
      // Edits apply at once, though Claude learns only with the next message.
      expect(await guardOf(f)(...preToolUse('Edit'))).toEqual({})
    })
  })
})

describe('Ultracode and background tasks', () => {
  // A CLI double that reads the service's input stream as the real one does.
  function scripted(f: ReturnType<typeof fixture>, script: (read: () => Promise<IteratorResult<any>>) => AsyncGenerator<any>) {
    f.sdk.query.mockImplementation(({ prompt }: any) => {
      const input = prompt[Symbol.asyncIterator]()
      return Object.assign(script(() => input.next()), { close: vi.fn() }) as any
    })
  }
  const system = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: 'system', subtype, session_id: 's', ...fields })
  const workflowCall = assistant('a1', [{ type: 'tool_use', id: 'w1', name: 'Workflow', input: { script: 'phase()' } }])
  const launched = { type: 'user', session_id: 's', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'Workflow launched in background. Task ID: t1' }] } }
  const live = (...ids: string[]) => system('background_tasks_changed', { tasks: ids.map(task_id => ({ task_id, task_type: 'local_workflow', description: task_id })) })
  const started = system('task_started', { task_id: 't1', tool_use_id: 'w1', task_type: 'local_workflow', workflow_name: 'red-blue', description: 'Two agents' })
  const progress = system('task_progress', { task_id: 't1', tool_use_id: 'w1', description: 'Colors: blue', usage: { total_tokens: 900, tool_uses: 0, duration_ms: 400 },
    workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'Colors' },
      { type: 'workflow_agent', index: 1, label: 'red', phaseTitle: 'Colors', state: 'done' },
      { type: 'workflow_agent', index: 2, label: 'blue', phaseTitle: 'Colors', state: 'start' }] })
  const finished = [
    system('task_updated', { task_id: 't1', patch: { status: 'completed' } }),
    system('task_notification', { task_id: 't1', tool_use_id: 'w1', status: 'completed', summary: 'Workflow "Two agents" completed',
      usage: { total_tokens: 1800, tool_uses: 0, duration_ms: 1500 } }),
    live(),
  ]
  const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 30))])
  // The run's mailbox; `add` queues a message the way the composer does.
  const queue = () => {
    const entries: Array<{ requestId: string; prompt: string; status: string; offered?: boolean }> = []
    let wake = () => {}
    const bridge = {
      subscribe: (next: () => void) => { wake = next; return () => {} },
      prepareNext: async () => {
        const entry = entries.find(row => row.status === 'queued' && !row.offered)
        if (!entry) return null
        entry.offered = true
        return { requestId: entry.requestId, prompt: entry.prompt, images: [] }
      },
      deliver: vi.fn((requestId: string, parentId: string | null, _mode?: any) => {
        entries.find(row => row.requestId === requestId)!.status = 'delivered'
        return { id: `user-${requestId}`, parentId }
      }),
      recordModeSwitch: vi.fn(), release: vi.fn(), bindCancel: vi.fn(),
      tryClose: vi.fn(() => !entries.some(row => row.status === 'queued')),
    }
    return { bridge, add(requestId: string, prompt = requestId) { entries.push({ requestId, prompt, status: 'queued' }); wake() } }
  }
  const taskOn = (f: ReturnType<typeof fixture>, rowId: string) => {
    const update = f.sink.updateAssistantToolState.mock.calls.filter(([id]: any[]) => id === rowId).at(-1)?.[1]
    return update?.contentBlocks.find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'w1')?.task
  }

  it('passes ultracode as a session flag setting only when the request asks for it', async () => {
    for (const ultracode of [true, false]) {
      const f = fixture([assistant(), success])
      if (ultracode) f.input.request.claudeUltracode = true
      await f.service.run(f.input)
      expect(f.sdk.query.mock.calls[0][0].options.settings).toEqual({ plansDirectory: path.join('.ygg', 'plans'), ...(ultracode ? { ultracode: true } : {}) })
    }
  })

  it('keeps the session open while a workflow runs, then persists the turn that answers its end', async () => {
    const f = fixture()
    let afterFirst: Promise<IteratorResult<any>> | undefined
    scripted(f, async function* (read) {
      await read()
      yield workflowCall
      yield live('t1')
      yield started
      yield launched
      yield assistant('a2', [{ type: 'text', text: 'The workflow is running in the background.' }])
      yield success
      afterFirst = read()
      // The result left a task running: the session stays open.
      expect(await settled(afterFirst)).toBe('pending')
      yield progress
      for (const event of finished) yield event
      // Claude answers the finished task with a turn of its own.
      yield system('init', { permissionMode: 'default' })
      yield assistant('a3', [{ type: 'text', text: 'RED BLUE' }])
      yield success
      expect((await afterFirst).done).toBe(true)
    })
    const final = await f.service.run(f.input)
    expect(final.content).toBe('RED BLUE')
    expect(f.rows.map(row => row.parentId)).toEqual(['u', 'row0', 'row1'])
    expect(f.sessions.record).toHaveBeenLastCalledWith(final.id, 's', 'a3', '/workspace', true)
    expect(taskOn(f, 'row0')).toEqual({ id: 't1', kind: 'local_workflow', status: 'completed', description: 'Two agents', workflowName: 'red-blue',
      summary: 'Workflow "Two agents" completed', usage: { totalTokens: 1800, toolUses: 0, durationMs: 1500 },
      agents: [{ label: 'red', phase: 'Colors', state: 'done' }, { label: 'blue', phase: 'Colors', state: 'start' }] })
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistant_message_persisted', message: expect.objectContaining({ id: 'row0' }) }))
  })

  it('keeps the queue open while background work runs, so a message sent meanwhile reaches Claude', async () => {
    const f = fixture(); const q = queue(); f.input.queuedInput = q.bridge
    scripted(f, async function* (read) {
      await read()
      yield workflowCall
      yield live('t1')
      yield started
      yield launched
      yield success
      // Not closed: the queue still takes the user's message, which starts a turn while the workflow runs.
      expect(q.bridge.tryClose).not.toHaveBeenCalled()
      q.add('r1', 'what is taking so long?')
      const queued = (await read()).value
      yield { type: 'command_lifecycle', command_uuid: queued.uuid, state: 'started', session_id: 's' }
      yield assistant('a2', [{ type: 'text', text: 'Still running.' }])
      yield success
      for (const event of finished) yield event
      yield system('init', { permissionMode: 'default' })
      yield assistant('a3', [{ type: 'text', text: 'Done.' }])
      yield success
      expect((await read()).done).toBe(true)
    })
    const final = await f.service.run(f.input)
    expect(final.content).toBe('Done.')
    expect(q.bridge.deliver).toHaveBeenCalledWith('r1', 'row0', expect.anything())
  })

  it('shows only tasks the main agent launched; child agents\' tasks still keep the session open', async () => {
    const f = fixture()
    let afterFirst: Promise<IteratorResult<any>> | undefined
    scripted(f, async function* (read) {
      await read()
      yield workflowCall
      yield started
      yield launched
      yield success
      afterFirst = read()
      yield system('task_notification', { task_id: 't1', tool_use_id: 'w1', status: 'completed', summary: 'done' })
      // A child agent's backgrounded Bash, on a call Graviton never saw.
      yield live('child')
      yield system('task_started', { task_id: 'child', tool_use_id: 'toolu_child', task_type: 'local_bash', description: 'sleep 25', owned_by_subagent: true })
      yield system('init', { permissionMode: 'default' })
      yield assistant('a2', [{ type: 'text', text: 'answered' }])
      yield success
      expect(await settled(afterFirst)).toBe('pending')
      yield live()
      expect((await afterFirst).done).toBe(true)
    })
    await f.service.run(f.input)
    const tasks = f.sink.updateAssistantToolState.mock.calls.flatMap(([, update]: any[]) => update.contentBlocks)
      .map((block: any) => block.task?.id).filter(Boolean)
    expect(new Set(tasks)).toEqual(new Set(['t1']))
  })

  it('marks a task that was still running as stopped when the run ends early', async () => {
    const f = fixture()
    scripted(f, async function* (read) {
      await read()
      yield workflowCall
      yield live('t1')
      yield started
      yield launched
      throw new Error('CLI exited')
    })
    await expect(f.service.run(f.input)).rejects.toThrow('CLI exited')
    expect(taskOn(f, 'row0')).toMatchObject({ id: 't1', status: 'stopped' })
  })

  it('publishes the tasks keeping a finished turn open, and stops or reads one on request', async () => {
    const f = fixture()
    const stopTask = vi.fn(async () => {})
    const getTaskOutput = vi.fn(async () => ({ output: 'listening on :8090\n', total_bytes: 19, truncated: false }))
    let control: ClaudeTaskControl | undefined
    f.input.bindTasks = (bound: ClaudeTaskControl) => { control = bound; return () => { control = undefined } }
    const server = { id: 'srv', kind: 'local_bash', description: 'Start the dev server' }
    f.sdk.query.mockImplementation(({ prompt }: any) => {
      const input = prompt[Symbol.asyncIterator]()
      return Object.assign((async function* () {
        await input.next()
        yield assistant('a1', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'bun run dev', run_in_background: true } }])
        // An ambient watcher is not activity, and the level can name a task before task_started does.
        yield system('background_tasks_changed', { tasks: [{ task_id: 'srv', task_type: 'local_bash', description: server.description },
          { task_id: 'watch', task_type: 'monitor', description: 'watch', ambient: true }] })
        yield system('task_started', { task_id: 'srv', tool_use_id: 'b1', task_type: 'local_bash', description: server.description })
        yield { type: 'user', session_id: 's', parent_tool_use_id: null,
          message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background with ID: srv' }] } }
        yield assistant('a2', [{ type: 'text', text: 'The server is up.' }])
        yield success
        expect(await control!.output('srv')).toEqual({ output: 'listening on :8090\n', totalBytes: 19, truncated: false })
        expect(await control!.stop('watch')).toBe(false)
        expect(await control!.stop('srv')).toBe(true)
        yield system('task_notification', { task_id: 'srv', tool_use_id: 'b1', status: 'stopped', summary: 'Stopped' })
        yield system('background_tasks_changed', { tasks: [] })
        yield system('init', { permissionMode: 'default' })
        yield assistant('a3', [{ type: 'text', text: 'Stopped the server.' }])
        yield success
      })(), { close: vi.fn(), stopTask, getTaskOutput })
    })
    await f.service.run(f.input)
    expect(stopTask).toHaveBeenCalledWith('srv')
    expect(getTaskOutput).toHaveBeenCalledWith('srv')
    expect(control).toBeUndefined()
    expect(f.emit.mock.calls.map(([event]) => event).filter(event => event.type === 'background_tasks')).toEqual([
      { type: 'background_tasks', streamId: 'stream', lineageId: 'l', turnActive: true, tasks: [{ ...server, toolUseId: null }] },
      { type: 'background_tasks', streamId: 'stream', lineageId: 'l', turnActive: true, tasks: [{ ...server, toolUseId: 'b1' }] },
      { type: 'background_tasks', streamId: 'stream', lineageId: 'l', turnActive: false, tasks: [{ ...server, toolUseId: 'b1' }] },
      { type: 'background_tasks', streamId: 'stream', lineageId: 'l', turnActive: false, tasks: [] },
    ])
  })

  it("adds each running agent's progress to the published task list, a child agent's included", async () => {
    const f = fixture()
    const usage = { total_tokens: 340_000, tool_uses: 12, duration_ms: 252_000 }
    scripted(f, async function* (read) {
      await read()
      yield assistant('a1', [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Implement P5', run_in_background: true } }])
      yield system('background_tasks_changed', { tasks: [{ task_id: 'ag', task_type: 'local_agent', description: 'Implement P5' },
        { task_id: 'kid', task_type: 'local_agent', description: 'Review diff' }] })
      yield system('task_started', { task_id: 'ag', tool_use_id: 'ag1', task_type: 'local_agent', description: 'Implement P5' })
      yield { type: 'user', session_id: 's', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Async agent launched successfully.' }] } }
      yield assistant('a2', [{ type: 'text', text: 'Running in the background.' }])
      yield success
      yield system('task_progress', { task_id: 'ag', tool_use_id: 'ag1', description: 'Implement P5', summary: 'Running vitest suites', last_tool_name: 'Bash', usage })
      // A task a child agent launched: its call was never projected, but it is in the composer's list.
      yield system('task_progress', { task_id: 'kid', tool_use_id: 'child-call', description: 'Review diff', last_tool_name: 'Read',
        usage: { total_tokens: 900, tool_uses: 1, duration_ms: 2_000 } })
      // Progress publishes are coalesced to one a second.
      await new Promise(resolve => setTimeout(resolve, 1_100))
      yield system('task_notification', { task_id: 'ag', tool_use_id: 'ag1', status: 'completed', summary: 'P5 done', usage })
      yield system('background_tasks_changed', { tasks: [] })
      yield system('init', { permissionMode: 'default' })
      yield assistant('a3', [{ type: 'text', text: 'P5 is done.' }])
      yield success
    })
    await f.service.run(f.input)
    expect(f.sdk.query.mock.calls[0][0].options.agentProgressSummaries).toBe(true)
    const published = f.emit.mock.calls.map(([event]) => event).filter(event => event.type === 'background_tasks')
    const withProgress = published.filter(event => event.tasks.some((task: any) => task.progress))
    expect(withProgress).toHaveLength(1)
    expect(withProgress[0]).toMatchObject({ turnActive: false, tasks: [
      { id: 'ag', toolUseId: 'ag1', progress: 'Running vitest suites', lastTool: 'Bash', usage: { totalTokens: 340_000, toolUses: 12, durationMs: 252_000 } },
      { id: 'kid', toolUseId: null, lastTool: 'Read', usage: { totalTokens: 900, toolUses: 1, durationMs: 2_000 } },
    ] })
    expect(published.at(-1)).toMatchObject({ tasks: [] })
  })

  it.skipIf(process.env.CLAUDE_PROVIDER_LIVE_TEST !== '1')('live service: an ultracode workflow keeps the session and queue open and shows its progress', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const native = await import('@anthropic-ai/claude-agent-sdk')
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'graviton-claude-workflow-'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 280_000)
    const f = fixture(); const q = queue()
    f.broker.initSession('stream', { autoApproveAll: true })
    Object.assign(f.input, { cwd, signal: controller.signal, queuedInput: q.bridge })
    Object.assign(f.input.request, { modelName: process.env.CLAUDE_WORKFLOW_MODEL || 'claude-sonnet-5-5', claudeUltracode: true,
      content: 'Use the Workflow tool to run a tiny workflow of exactly two agents in parallel. The first agent must use Bash to run ' +
        '`sleep 20 && echo RED` and reply with its output; the second the same with `sleep 20 && echo BLUE`. ' +
        'When the workflow finishes, reply with both words.' })
    f.sdk.query.mockImplementation((args: any) => native.query({ ...args, options: { ...args.options,
      pathToClaudeCodeExecutable: process.env.CLAUDE_BRIDGE_BINARY || path.join(os.homedir(), '.local/bin/claude') } }) as any)
    // Every state the Workflow call's task passed through, as the transcript saw it.
    const states: string[] = []
    let queuedWhile: string | undefined
    f.input.emit = (event: any) => {
      f.emit(event)
      if (event.type !== 'assistant_message_persisted') return
      const blocks = typeof event.message.content_blocks === 'string' ? JSON.parse(event.message.content_blocks) : event.message.contentBlocks ?? event.message.content_blocks
      const task = (blocks ?? []).find((block: any) => block.type === 'tool_result' && block.task)?.task
      if (!task) return
      if (states.at(-1) !== task.status) states.push(task.status)
      // Sent once the workflow is under way; the open queue must deliver it before the workflow ends.
      if (task.status === 'running' && !queuedWhile) { queuedWhile = 'running'; q.add('r1', 'While that runs, reply with the word PURPLE.') }
    }
    q.bridge.deliver.mockImplementation((requestId: string, parentId: string | null) => {
      queuedWhile = states.at(-1)
      return { id: `user-${requestId}`, parentId }
    })
    try {
      const final = await f.service.run(f.input)
      expect(states).toEqual(['running', 'completed'])
      expect(q.bridge.deliver).toHaveBeenCalledOnce()
      expect(queuedWhile).toBe('running')
      expect(final.content).toMatch(/RED/)
      expect(final.content).toMatch(/BLUE/)
      const workflowRow = f.sink.updateAssistantToolState.mock.calls.map(([, update]: any[]) => update.contentBlocks)
        .flat().filter((block: any) => block?.type === 'tool_result' && block.task).at(-1)
      expect(workflowRow.task).toMatchObject({ kind: 'local_workflow', status: 'completed' })
      expect(workflowRow.task.agents?.length).toBe(2)
    } finally {
      clearTimeout(timer)
      await rm(cwd, { recursive: true, force: true })
    }
  }, 300_000)
})

describe('Claude Code MCP servers (native, v1)', () => {
  const init = (mcp_servers: any[]) => ({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'default', mcp_servers })
  const withMcp = (f: ReturnType<typeof fixture>, preferences: any) => { (f.service as any).deps.nativeMcp = () => preferences }

  it('keeps MCP strict and empty when the host setting is absent or off', async () => {
    for (const preferences of [undefined, { enabled: false, claudeAiConnectors: true, disabledServers: ['x'] }]) {
      const f = fixture([assistant(), success])
      if (preferences) withMcp(f, preferences)
      await f.service.run(f.input)
      const options = f.sdk.query.mock.calls[0][0].options
      expect(options).toMatchObject({ strictMcpConfig: true, mcpServers: {} })
      expect(options).not.toHaveProperty('disallowedTools')
      expect(options.settings).not.toHaveProperty('disableClaudeAiConnectors')
    }
  })

  it('loads Claude\'s own MCP configuration, hides disabled servers by rule and can drop claude.ai connectors', async () => {
    const f = fixture([assistant(), success])
    withMcp(f, { enabled: true, claudeAiConnectors: false, disabledServers: ['claude.ai Vega GP (UAT env)', 'plugin:slack:slack'] })
    f.input.request.claudeUltracode = true
    await f.service.run(f.input)
    const options = f.sdk.query.mock.calls[0][0].options
    expect(options.strictMcpConfig).toBe(false)
    expect(options).not.toHaveProperty('mcpServers')
    expect(options.disallowedTools).toEqual(['mcp__claude_ai_Vega_GP_UAT_env', 'mcp__plugin_slack_slack'])
    expect(options.settings).toMatchObject({ ultracode: true, disableClaudeAiConnectors: true, plansDirectory: expect.any(String) })
  })

  it('keeps MCP off for the run when the setting cannot be read', async () => {
    const f = fixture([assistant(), success])
    ;(f.service as any).deps.nativeMcp = () => { throw new Error('corrupt') }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try { await f.service.run(f.input) } finally { warn.mockRestore() }
    expect(f.sdk.query.mock.calls[0][0].options).toMatchObject({ strictMcpConfig: true, mcpServers: {} })
  })

  it('warns when a resumed run starts without the MCP servers earlier runs had (CLI #78820)', async () => {
    const f = fixture()
    withMcp(f, { enabled: true, claudeAiConnectors: true, disabledServers: [] })
    const run = (events: any[]) => {
      f.sdk.query.mockImplementationOnce(() => Object.assign((async function* () { for (const event of events) yield event })(), { close: vi.fn() }))
      return f.service.run(f.input)
    }
    await run([init([{ name: 'linear', status: 'connected' }]), assistant(), success])
    expect(f.emit.mock.calls.some(([event]) => event.code === 'claude_mcp_unavailable')).toBe(false)
    f.state.checkpoint = { session_id: 's', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
    f.input.sourceMessageId = 'tail'
    await run([init([]), assistant('b'), success])
    expect(f.sdk.query.mock.calls[1][0].options.resume).toBe('s')
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', code: 'claude_mcp_unavailable' }))
  })

  it('does not warn about an empty server list nobody configured', async () => {
    const f = fixture([init([]), assistant(), success])
    withMcp(f, { enabled: true, claudeAiConnectors: true, disabledServers: [] })
    f.state.branch = { session_id: 's', state: 'ready' }
    f.state.checkpoint = { session_id: 's', message_uuid: 'checkpoint', cwd: '/workspace', resumable: 1 }
    f.input.sourceMessageId = 'tail'
    await f.service.run(f.input)
    expect(f.emit.mock.calls.some(([event]) => event.code === 'claude_mcp_unavailable')).toBe(false)
  })
})
