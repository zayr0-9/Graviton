import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReplDispatchExecutor, ReplSessions } from '../replExecutor.js'
import { createChatPausingExecutor } from '../chatOrchestrator.js'
import { DecisionBroker } from '../decisionBroker.js'
import { REPL_GUIDE } from '../../../../../../shared/replGuide.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../../shared/builtinToolDefinitions.js'
import type { ToolExecutionContext, ToolExecutor } from '../toolLoopService.js'

const stores: ReplSessions[] = []
afterEach(() => { for (const store of stores.splice(0)) store.clear() })
function setup(nested: ToolExecutor = async () => ({ success: true, content: 'secret payload\nlicense: MIT' })) {
  const sessions = new ReplSessions()
  stores.push(sessions)
  const leaf = vi.fn(nested)
  const dispatch = createReplDispatchExecutor(leaf, sessions)
  const context: ToolExecutionContext = {
    conversationId: 'chat', messageId: 'msg', lineageId: 'branch', operationMode: 'execute',
    allowedToolNames: new Set(['read_file', 'browse_web', 'edit_file', 'mcp__test', 'subagent_manager']),
    nestedExecutor: leaf,
  }
  let id = 0
  const run = (args: any, overrides: Partial<ToolExecutionContext> = {}) => dispatch({ id: `cell-${++id}`, name: 'repl', arguments: args }, { ...context, ...overrides })
  return { run, leaf, dispatch, context }
}
const capture = { action: 'invoke', tool: 'read_file', args: { path: 'sample.txt' }, assign: 'page' }

describe('replExecutor', () => {
  it('returns the exact definition guide on demand without creating a session or invoking tools', async () => {
    const { run, leaf } = setup()
    const definition = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'repl')!
    expect(definition.description).toBe(REPL_GUIDE)
    expect(definition.inputSchema.properties.howto.type).toBe('boolean')
    expect(definition.inputSchema.required ?? []).not.toContain('action')
    expect(await run({ howto: true }, { lineageId: null })).toEqual({ success: true, howto: REPL_GUIDE })
    expect(leaf).not.toHaveBeenCalled()
    // Help must not consume the bounded session slots.
    for (let i = 0; i < 20; i++) await run({ howto: true }, { lineageId: `help-${i}` })
    expect((await run({ action: 'list' })).variables).toEqual([])
  })

  it('treats howto as help-only even with execution/reset fields and validates its type', async () => {
    const { run, leaf } = setup()
    await run(capture)
    expect(await run({ ...capture, howto: true })).toEqual({ success: true, howto: REPL_GUIDE })
    await run({ action: 'reset', howto: true })
    expect(await run({ action: 'inspect', variable: 'page' })).toMatchObject({ type: 'object' })
    expect(leaf).toHaveBeenCalledTimes(1)
    await expect(run({ howto: 'true' })).rejects.toThrow('boolean')
    await expect(run({ howto: false })).rejects.toThrow('action')
    const controller = new AbortController()
    controller.abort()
    await expect(run({ howto: true }, { signal: controller.signal })).rejects.toThrow()
  })

  it('captures through the nested executor without exposing contents, then filters and shows', async () => {
    const { run, leaf } = setup()
    const receipt = await run(capture)
    expect(receipt).toMatchObject({ status: 'stored', variable: 'page', toolStatus: 'success', revision: 1, lastWriter: 'main' })
    expect(JSON.stringify(receipt)).not.toContain('secret payload')
    expect(leaf.mock.calls[0][0]).toEqual({ id: 'cell-1:invoke', name: 'read_file', arguments: { path: 'sample.txt' } })
    expect(await run({ action: 'inspect', variable: 'page' })).toMatchObject({ type: 'object', keys: ['success', 'content'] })
    await run({ action: 'exec', code: 'var matches = page.content.split("\\n").filter(p => p.includes("license"));' })
    expect(await run({ action: 'show', variable: 'matches' })).toMatchObject({ content: '["license: MIT"]', truncated: false })
    expect(await run({ action: 'list' })).toMatchObject({ variables: [{ variable: 'page' }, { variable: 'matches' }] })
  })

  it('isolates branches and workspaces; shares agents and survives a new stream on the same branch', async () => {
    const { run } = setup()
    await run(capture)
    for (const overrides of [{ lineageId: 'other' }, { rootPath: '/other' }, { conversationId: 'other' }]) {
      await expect(run({ action: 'show', variable: 'page' }, overrides)).rejects.toThrow('Variable not found')
    }
    expect(await run({ action: 'inspect', variable: 'page' }, { streamId: 'new' })).toMatchObject({ type: 'object' })
    expect(await run({ action: 'inspect', variable: 'page' }, { replOwnerId: 'child' })).toMatchObject({ type: 'object' })
    await expect(run(capture, { lineageId: null })).rejects.toThrow('lineage')
  })

  it('requires explicit overwrite before executing another side effect', async () => {
    const { run, leaf } = setup()
    await run(capture)
    await expect(run(capture)).rejects.toThrow('overwrite')
    expect(leaf).toHaveBeenCalledTimes(1)
    await run({ ...capture, overwrite: true })
    expect(leaf).toHaveBeenCalledTimes(2)
    await run({ action: 'drop', variable: 'page' })
    await run(capture)
    await run({ action: 'reset' })
    expect((await run({ action: 'list' })).variables).toEqual([])
  })

  it('bounds and paginates explicit output', async () => {
    const { run } = setup()
    await run({ action: 'exec', code: 'var text = "abcdefgh";' })
    expect(await run({ action: 'show', variable: 'text', maxOutputChars: 3 })).toMatchObject({ content: 'abc', totalChars: 8, truncated: true, nextOffset: 3 })
    expect(await run({ action: 'show', variable: 'text', offset: 3, maxOutputChars: 5 })).toMatchObject({ content: 'defgh', truncated: false })
    await expect(run({ action: 'show', variable: 'text', maxOutputChars: 999999 })).rejects.toThrow('integer')
  })

  it('keeps exec silent by default and optionally shows only the selected variable', async () => {
    const { run } = setup()
    const definition = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'repl')!
    expect(definition.inputSchema.properties.show).toMatchObject({ type: 'string', maxLength: 64 })
    const silent = await run({ action: 'exec', code: 'var privateText = "secret payload"; privateText;' })
    expect(silent).toMatchObject({ success: true, status: 'executed', revision: 1 })
    expect(silent.content).toBeUndefined()
    expect(JSON.stringify(silent)).not.toContain('secret payload')
    const shown = await run({ action: 'exec', code: 'var selected = { license: "MIT" }; privateText;', show: 'selected' })
    expect(shown).toMatchObject({ success: true, status: 'executed', variable: 'selected', content: '{"license":"MIT"}', truncated: false, nextOffset: null, revision: 2, lastWriter: 'main' })
    expect(JSON.stringify(shown)).not.toContain('secret payload')
    expect((await run({ action: 'show', variable: 'selected' })).content).toBe(shown.content)
  })

  it('uses the same output defaults, bounds and pagination for exec with show', async () => {
    const { run } = setup()
    expect(await run({ action: 'exec', code: 'var text = "abcdefgh";', show: 'text', offset: 2, maxOutputChars: 3 }))
      .toMatchObject({ content: 'cde', totalChars: 8, truncated: true, nextOffset: 5 })
    expect(await run({ action: 'show', variable: 'text', offset: 5, maxOutputChars: 3 }))
      .toMatchObject({ content: 'fgh', truncated: false, nextOffset: null })
    expect(await run({ action: 'exec', code: 'var large = "x".repeat(21000);', show: 'large' }))
      .toMatchObject({ content: 'x'.repeat(4000), totalChars: 21000, nextOffset: 4000 })
    expect(await run({ action: 'exec', code: 'large;', show: 'large', maxOutputChars: 20000 }))
      .toMatchObject({ content: 'x'.repeat(20000), nextOffset: 20000 })
  })

  it('validates exec disclosure parameters before executing code', async () => {
    const { run } = setup()
    await run({ action: 'exec', code: 'var count = 0;' })
    for (const params of [{ show: true }, { show: '' }, { show: 'count.value' }, { show: 'count', offset: -1 }, { show: 'count', maxOutputChars: 20001 }]) {
      await expect(run({ action: 'exec', code: 'count++;', ...params })).rejects.toThrow()
    }
    expect(await run({ action: 'show', variable: 'count' })).toMatchObject({ content: '0', revision: 1 })
  })

  it('skips disclosure on exec failure and reports completed execution on show failure', async () => {
    const { run } = setup()
    await run({ action: 'exec', code: 'var count = 0;' })
    await expect(run({ action: 'exec', code: 'count++; throw Error("partial");', show: 'missing' })).rejects.toThrow('partial')
    expect((await run({ action: 'show', variable: 'count' })).content).toBe('1')
    await expect(run({ action: 'exec', code: 'count++;', show: 'missing' })).rejects.toThrow('exec completed, but show failed')
    expect(await run({ action: 'show', variable: 'count' })).toMatchObject({ content: '2', revision: 3 })
    await expect(run({ action: 'exec', code: 'var cyclic = {}; cyclic.self = cyclic;', show: 'cyclic' })).rejects.toThrow('State changes remain')
    expect(await run({ action: 'inspect', variable: 'cyclic' })).toMatchObject({ type: 'object', keys: ['self'] })
  })

  it('keeps combined execution and disclosure together across queued sibling cells', async () => {
    const { run } = setup()
    const first = run({ action: 'exec', code: 'var count = 1;', show: 'count' })
    const second = run({ action: 'exec', code: 'count = 2;', show: 'count' }, { replOwnerId: 'child' })
    expect(await first).toMatchObject({ content: '1', revision: 1, lastWriter: 'main' })
    expect(await second).toMatchObject({ content: '2', revision: 2, lastWriter: 'child' })
  })

  it('does not grant Node or network access and interrupts infinite loops', async () => {
    const { run } = setup()
    await run({ action: 'exec', code: 'var access = [typeof process, typeof require, typeof fetch];' })
    expect((await run({ action: 'show', variable: 'access' })).content).toBe('["undefined","undefined","undefined"]')
    await expect(run({ action: 'exec', code: 'while (true) {}', timeoutMs: 5 })).rejects.toThrow('interrupted')
    await run({ action: 'exec', code: 'var stillAlive = true;' })
    expect((await run({ action: 'show', variable: 'stillAlive' })).content).toBe('true')
  })

  it('stores failures but propagates cancellation', async () => {
    const { run } = setup(async () => { throw new Error('tool denied') })
    expect(await run(capture)).toMatchObject({ toolStatus: 'error' })
    expect((await run({ action: 'show', variable: 'page' })).content).toContain('tool denied')
    const controller = new AbortController()
    controller.abort()
    await expect(run({ ...capture, assign: 'other' }, { signal: controller.signal })).rejects.toThrow()
  })

  it('fails closed for unavailable tools, mode violations and bypass attempts', async () => {
    const { run, leaf } = setup()
    for (const tool of ['repl', 'multi_call', 'skill_manager', 'html_renderer', 'view_image', 'unavailable']) {
      expect(await run({ ...capture, tool, overwrite: true })).toMatchObject({ toolStatus: 'error' })
    }
    expect(await run({ ...capture, tool: 'edit_file', overwrite: true }, { operationMode: 'plan' })).toMatchObject({ toolStatus: 'error' })
    expect(await run({ ...capture, tool: 'mcp__test', overwrite: true }, { operationMode: 'plan' })).toMatchObject({ toolStatus: 'error' })
    expect(await run({ ...capture, overwrite: true }, { nestedExecutor: undefined })).toMatchObject({ toolStatus: 'error' })
    expect(leaf).not.toHaveBeenCalled()
  })

  it('keeps ephemeral modelContent out of captured values', async () => {
    const { run } = setup(async () => ({ modelContent: 'sensitive image bytes', persistedContent: { size: 10 } }))
    expect(await run(capture)).toMatchObject({ metadataOnly: true })
    expect((await run({ action: 'show', variable: 'page' })).content).toBe('{"size":10}')
  })

  it('does not lock the workspace during capture and prevents resetting in-flight captures', async () => {
    let resolve!: (value: any) => void
    const { run } = setup(() => new Promise(done => { resolve = done }))
    const first = run(capture)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await run({ action: 'exec', code: 'var other = 42;' }, { replOwnerId: 'child' })
    await expect(run({ action: 'reset' })).rejects.toThrow('in flight')
    resolve({ done: true })
    expect(await first).toMatchObject({ status: 'stored' })
    expect((await run({ action: 'show', variable: 'other' })).content).toBe('42')
  })

  it('supports isolated agent identity without parent lineage and enforces the caller allowlist', async () => {
    const { run, leaf } = setup()
    const agent = { lineageId: null, replOwnerId: 'agent-1', allowedToolNames: new Set(['read_file']) }
    await run(capture, agent)
    expect(await run({ action: 'inspect', variable: 'page' }, agent)).toMatchObject({ type: 'object' })
    expect(await run({ ...capture, tool: 'edit_file', overwrite: true }, agent)).toMatchObject({ toolStatus: 'error' })
    expect(leaf).toHaveBeenCalledTimes(1)
  })

  it('expires idle sessions and rejects oversized results without repeating execution', async () => {
    const { run, leaf } = setup(async () => 'x'.repeat(8 * 1024 * 1024 + 1))
    await expect(run(capture)).rejects.toThrow('exceeds 8 MiB')
    expect(leaf).toHaveBeenCalledTimes(1)
    await run({ action: 'exec', code: 'var short = 1;' })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000)
    try { expect((await run({ action: 'list' })).variables).toEqual([]) }
    finally { clock.mockRestore() }
  })

  it('rejects non-data results without running getters or toJSON', async () => {
    const getter = vi.fn(() => 'bad')
    const result = Object.defineProperty({}, 'content', { enumerable: true, get: getter })
    const { run } = setup(async () => result)
    await expect(run(capture)).rejects.toThrow('accessor')
    expect(getter).not.toHaveBeenCalled()
  })

  it('keeps error serialization inside the interrupted runtime', async () => {
    const { run } = setup()
    await expect(run({ action: 'exec', code: 'throw { toJSON() { while(true) {} } };', timeoutMs: 5 })).rejects.toThrow()
  })

  it('re-enters normal permissions for the nested tool', async () => {
    const { dispatch, context, leaf } = setup()
    const broker = new DecisionBroker()
    broker.initSession('stream', { autoApproveAll: false })
    const events: any[] = []
    const execute = createChatPausingExecutor({ base: dispatch, broker, streamId: 'stream', emit: e => events.push(e) })
    const pending = execute({ id: 'outer', name: 'repl', arguments: capture }, { ...context, streamId: 'stream', nestedExecutor: undefined })
    await vi.waitFor(() => expect(events.some(e => e.toolCallId === 'outer')).toBe(true))
    broker.resolve('stream', 'outer', 'allow_once')
    await vi.waitFor(() => expect(events.some(e => e.toolCallId === 'outer:invoke')).toBe(true))
    expect(leaf).not.toHaveBeenCalled()
    broker.resolve('stream', 'outer:invoke', 'deny')
    expect(await pending).toMatchObject({ toolStatus: 'error' })
    expect(leaf).not.toHaveBeenCalled()
  })
})


describe('shared REPL workspaces', () => {
  it('queues concurrent agent cells in FIFO order and attributes changes', async () => {
    const { run } = setup()
    const cells = Array.from({ length: 20 }, (_, i) => run({ action: 'exec', code: 'var count = (typeof count === "undefined" ? 0 : count) + 1;' }, { replOwnerId: `child-${i}` }))
    const receipts = await Promise.all(cells)
    expect(receipts.map(r => r.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await run({ action: 'show', variable: 'count' })).toMatchObject({ content: '20', revision: 20, lastWriter: 'child-19' })
  })

  it('lets a child mutate state while a parent captures its wait result (no deadlock)', async () => {
    let run!: ReturnType<typeof setup>['run']
    const state = setup(async () => {
      await run({ action: 'exec', code: 'findings.license = "MIT";' }, { replOwnerId: 'child' })
      return { status: 'completed' }
    })
    run = state.run
    await run({ action: 'exec', code: 'var findings = {};' })
    expect(await run({ ...capture, tool: 'subagent_manager', args: { action: 'wait', handle: '123456' }, assign: 'report' })).toMatchObject({ status: 'stored' })
    expect((await run({ action: 'show', variable: 'findings' })).content).toBe('{"license":"MIT"}')
  })

  it('reserves destinations before tool execution and releases reservations on cancellation', async () => {
    let release!: (value: any) => void
    const { run, leaf } = setup(() => new Promise(resolve => { release = resolve }))
    const controller = new AbortController()
    const first = run(capture, { signal: controller.signal })
    const rejected = expect(first).rejects.toThrow()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(run({ ...capture, overwrite: true }, { replOwnerId: 'child' })).rejects.toThrow('reserved')
    await expect(run({ action: 'drop', variable: 'page' })).rejects.toThrow('reserved')
    expect(leaf).toHaveBeenCalledTimes(1)
    controller.abort()
    release({ ignored: true })
    await rejected
    expect((await run({ action: 'list' })).pendingCaptures).toEqual([])
  })

  it('preserves a concurrent edit on conflict and retains the tool result under a new name', async () => {
    let release!: (value: any) => void
    const { run } = setup(() => new Promise(resolve => { release = resolve }))
    await run({ action: 'exec', code: 'var page = {value: 1};' })
    const first = run({ ...capture, overwrite: true })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await run({ action: 'exec', code: 'page.value = 2;' }, { replOwnerId: 'child' })
    release({ value: 99 })
    const result = await first
    expect(result).toMatchObject({ status: 'conflict', variable: 'page', toolExecuted: true })
    expect((await run({ action: 'show', variable: 'page' })).content).toBe('{"value":2}')
    expect((await run({ action: 'show', variable: result.resultVariable })).content).toBe('{"value":99}')
  })

  it('detects a new destination written during capture even without overwrite', async () => {
    let release!: (value: any) => void
    const { run } = setup(() => new Promise(resolve => { release = resolve }))
    const first = run(capture)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await run({ action: 'exec', code: 'var page = "child data";' }, { replOwnerId: 'child' })
    release('tool data')
    expect(await first).toMatchObject({ status: 'conflict' })
    expect((await run({ action: 'show', variable: 'page' })).content).toBe('child data')
  })

  it('allows independent simultaneous captures into different destinations', async () => {
    const releases: Array<(value: any) => void> = []
    const { run } = setup(() => new Promise(resolve => releases.push(resolve)))
    const a = run({ ...capture, assign: 'a' })
    const b = run({ ...capture, assign: 'b' }, { replOwnerId: 'child' })
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1](2)
    releases[0](1)
    expect((await Promise.all([a, b])).map(r => r.status)).toEqual(['stored', 'stored'])
  })

  it('rejects child reset but permits coordinated parent reset', async () => {
    const { run } = setup()
    await run({ action: 'exec', code: 'var shared = 1;' }, { replOwnerId: 'child' })
    await expect(run({ action: 'reset' }, { replOwnerId: 'child' })).rejects.toThrow('parent')
    await run({ action: 'reset' })
    expect((await run({ action: 'list' })).variables).toEqual([])
  })

  it('cancels a queued cell without running it or breaking subsequent FIFO cells', async () => {
    const { run } = setup()
    const initial = run({ action: 'exec', code: 'var count = 1;' })
    const controller = new AbortController()
    const cancelled = run({ action: 'exec', code: 'count = 99;' }, { signal: controller.signal })
    const rejection = expect(cancelled).rejects.toThrow()
    controller.abort()
    const next = run({ action: 'exec', code: 'count += 1;' }, { replOwnerId: 'child' })
    await Promise.all([initial, rejection, next])
    expect((await run({ action: 'show', variable: 'count' })).content).toBe('2')
  })

  it('bounds the queue and leaves existing cells usable after overflow', async () => {
    const { run } = setup()
    const results = await Promise.allSettled(Array.from({ length: 70 }, () => run({ action: 'list' })))
    expect(results.some(r => r.status === 'rejected' && String(r.reason).includes('queue limit'))).toBe(true)
    expect((await run({ action: 'list' })).variables).toEqual([])
  })
})


describe('shared REPL recovery boundaries', () => {
  it('records partial failed cells and preserves their mutations against a late capture', async () => {
    let release!: (value: any) => void
    const { run } = setup(() => new Promise(resolve => { release = resolve }))
    await run({ action: 'exec', code: 'var page = 1;' })
    const pending = run({ ...capture, overwrite: true })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await expect(run({ action: 'exec', code: 'page = 2; throw Error("partial");' }, { replOwnerId: 'child' })).rejects.toThrow('partial')
    release(3)
    expect(await pending).toMatchObject({ status: 'conflict' })
    expect(await run({ action: 'show', variable: 'page' })).toMatchObject({ content: '2', revision: 3 })
  })

  it('keeps standalone no-lineage children private from each other and the parent', async () => {
    const { run } = setup()
    await run({ action: 'exec', code: 'var privateValue = 1;' }, { lineageId: null, replOwnerId: 'standalone-a' })
    await expect(run({ action: 'show', variable: 'privateValue' }, { lineageId: null, replOwnerId: 'standalone-b' })).rejects.toThrow('not found')
    await expect(run({ action: 'show', variable: 'privateValue' })).rejects.toThrow('not found')
  })

  it('allows cells on another branch while one branch awaits a tool', async () => {
    let release!: (value: any) => void
    const { run } = setup(() => new Promise(resolve => { release = resolve }))
    const pending = run(capture)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await run({ action: 'exec', code: 'var elsewhere = 2;' }, { lineageId: 'other' })
    expect((await run({ action: 'show', variable: 'elsewhere' }, { lineageId: 'other' })).content).toBe('2')
    release(1)
    await pending
  })
})


describe('shared REPL adversarial cancellation and intrinsics', () => {
  it('releases a hung capture immediately on abort without waiting for the underlying tool', async () => {
    const { run } = setup(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = run(capture, { signal: controller.signal })
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(async () => expect((await run({ action: 'list' })).pendingCaptures).toEqual(['page']))
    controller.abort()
    await rejection
    expect((await run({ action: 'list' })).pendingCaptures).toEqual([])
    await run({ action: 'reset' })
  })

  it('allows a private standalone child to release its own workspace slots', async () => {
    const { run } = setup()
    for (let i = 0; i < 20; i++) {
      const child = { lineageId: null, replOwnerId: `private-${i}` }
      await run({ action: 'exec', code: 'var local = 1;' }, child)
      await run({ action: 'reset' }, child)
    }
    expect((await run({ action: 'list' })).variables).toEqual([])
  })

  it('cannot redirect capture writes through guest-poisoned Object.defineProperty', async () => {
    const { run } = setup()
    await run({ action: 'exec', code: 'var page = 1; var define = Object.defineProperty; Object.defineProperty = function(obj, key, desc) { page = 999; return define(obj, key, desc); };' })
    await run({ ...capture, assign: 'other' })
    expect((await run({ action: 'show', variable: 'page' })).content).toBe('1')
  })
})
