import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReplDispatchExecutor, ReplSessions } from '../replExecutor.js'
import { createMultiCallDispatchExecutor } from '../multiCallExecutor.js'
import type { ChatHookSession } from '../chatHookService.js'
import { createChatPausingExecutor } from '../chatOrchestrator.js'
import { DecisionBroker } from '../decisionBroker.js'
import { REPL_GUIDE } from '../../../../../../shared/replGuide.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../../shared/builtinToolDefinitions.js'
import type { ToolExecutionContext, ToolExecutor } from '../toolLoopService.js'
import { promises as fs } from 'fs'
import { readTextFile, readFileContinuation } from '../../../tools/readFile.js'
import { createToolFsHarness } from '../../../tools/__tests__/helpers/toolFsHarness.js'

const stores: ReplSessions[] = []
afterEach(() => { for (const store of stores.splice(0)) store.clear() })
function setup(nested: ToolExecutor = async () => ({ success: true, content: 'secret payload\nlicense: MIT' })) {
  const sessions = new ReplSessions()
  stores.push(sessions)
  const leaf = vi.fn(nested)
  const dispatch = createMultiCallDispatchExecutor(createReplDispatchExecutor(leaf, sessions))
  const context: ToolExecutionContext = {
    conversationId: 'chat', messageId: 'msg', lineageId: 'branch', operationMode: 'execute',
    allowedToolNames: new Set(['multi_call', 'read_file', 'browse_web', 'edit_file', 'mcp__test', 'subagent_manager']),
    nestedExecutor: dispatch,
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

  it('reports the stored size in the receipt using the same measure as show', async () => {
    const { run } = setup()
    const receipt = await run(capture)
    const shown = await run({ action: 'show', variable: 'page', maxOutputChars: 1 })
    expect(receipt.totalChars).toBe(shown.totalChars)
    expect(receipt.totalChars).toBe(JSON.stringify({ success: true, content: 'secret payload\nlicense: MIT' }).length)

    const text = setup(async () => 'line "one"\nline two')
    const stringReceipt = await text.run({ ...capture, assign: 'raw' })
    expect(stringReceipt.totalChars).toBe('line "one"\nline two'.length)
    expect((await text.run({ action: 'show', variable: 'raw' })).totalChars).toBe(stringReceipt.totalChars)
  })

  it.each(['full', 'range', 'continuation'] as const)('captures a real %s file read with JSON-safe metadata and unchanged CSS', async mode => {
    const harness = await createToolFsHarness()
    const css = '/* café */\r\nbody { color: red; }\r\n'
    const path = await harness.writeFile('editorial-kit.css', css)
    const before = await fs.stat(path)
    const { run } = setup(async call => {
      const args = call.arguments as { path: string }
      const options = { cwd: harness.workspaceDir }
      const result = mode === 'continuation'
        ? await readFileContinuation(args.path, 0, 2, options)
        : await readTextFile(args.path, mode === 'range' ? { ...options, startLine: 1, endLine: 2 } : options)
      return { success: true, ...result }
    })
    const tool = mode === 'continuation' ? 'read_file_continuation' : 'read_file'
    const args = mode === 'continuation' ? { path, afterLine: 0, numLines: 2 }
      : mode === 'range' ? { path, startLine: 1, endLine: 2 } : { path }
    expect(await run({ action: 'invoke', tool, args, assign: 'css' }, {
      allowedToolNames: new Set([tool]),
    })).toMatchObject({ status: 'stored', toolStatus: 'success' })
    await run({ action: 'exec', code: 'var text = css.content; var modified = css.metadata.lastModified;' })
    expect((await run({ action: 'show', variable: 'text' })).content).toBe(mode === 'full' ? css : css.slice(0, -2))
    expect((await run({ action: 'show', variable: 'modified' })).content).toBe(before.mtime.toISOString())
    expect(await fs.readFile(path, 'utf8')).toBe(css)
    expect((await fs.stat(path)).mtimeMs).toBe(before.mtimeMs)
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
    for (const tool of ['repl', 'skill_manager', 'html_renderer', 'view_image', 'unavailable']) {
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


describe('async REPL scripts', () => {
  const script = (code: string, options = {}) => ({ action: 'exec', async: true, code, ...options })

  it('uses filtered tool data to choose a later read, storing only the return value', async () => {
    const { run, leaf } = setup(async call => {
      if (call.name === 'glob') return { success: true, matches: ['notes.txt', 'package.json'] }
      return { success: true, content: 'name: example\nprivate payload' }
    })
    const result = await run(script(`
      const result = await tools.call('glob', { pattern: '*' });
      const path = result.matches.find(name => name.endsWith('.json'));
      const page = await tools.call('read_file', { path });
      return page.content.split('\\n')[0];
    `, { assign: 'selected' }), { operationMode: 'plan', allowedToolNames: new Set(['glob', 'read_file']) })
    expect(result).toMatchObject({ status: 'stored', variable: 'selected' })
    expect(JSON.stringify(result)).not.toMatch(/name: example|private payload/)
    expect(leaf.mock.calls.map(([call]) => call)).toEqual([
      { id: 'cell-1:script:1', name: 'glob', arguments: { pattern: '*' } },
      { id: 'cell-1:script:2', name: 'read_file', arguments: { path: 'package.json' } },
    ])
    expect(await run({ action: 'show', variable: 'selected' })).toMatchObject({ content: 'name: example' })
  })

  it('isolates guest globals, suppresses split-channel data, and discards unassigned returns', async () => {
    const { run } = setup(async () => ({ persistedContent: 'allowed', modelContent: 'private' }))
    await run({ action: 'exec', code: 'var retained = 42; Promise.resolve().then(() => { retained = 0; });' })
    const result = await run(script(`globalThis.retained = 'local'; return await tools.call('read_file');`))
    expect(result).toMatchObject({ status: 'executed' })
    expect(JSON.stringify(result)).not.toMatch(/allowed|private/)
    await run(script(`return [typeof retained, await tools.call('read_file')];`, { assign: 'sample' }))
    expect((await run({ action: 'show', variable: 'sample' })).content).toBe('["undefined","allowed"]')
    expect((await run({ action: 'show', variable: 'retained' })).content).toBe('42')
  })

  it('fails closed on unavailable tools, missing policy, and restricted tool names', async () => {
    const { run, leaf } = setup()
    await expect(run(script(`await tools.call('read_file');`), { allowedToolNames: new Set() })).rejects.toThrow('not available')
    await expect(run(script(`await tools.call('read_file');`), { nestedExecutor: undefined })).rejects.toThrow('policy-aware')
    for (const tool of ['edit_file', 'bash', 'browse_web', 'multi_call', 'repl', 'subagent_manager']) {
      await expect(run(script(`try { await tools.call('${tool}'); } catch {}`), {
        allowedToolNames: new Set([tool]),
      })).rejects.toThrow('can only call')
    }
    expect(leaf).not.toHaveBeenCalled()
  })

  it('keeps separate approvals for each inner call', async () => {
    const { dispatch, context, leaf } = setup()
    const broker = new DecisionBroker()
    broker.initSession('stream', { autoApproveAll: false })
    const events: any[] = []
    const execute = createChatPausingExecutor({ base: dispatch, broker, streamId: 'stream', emit: e => events.push(e) })
    const pending = execute({ id: 'outer', name: 'repl', arguments: script(`
      await tools.call('read_file', { path: 'one' });
      await tools.call('read_file', { path: 'two' });
    `) }, { ...context, streamId: 'stream', nestedExecutor: undefined })
    const result = expect(pending).rejects.toThrow()
    for (const [id, decision, executed] of [
      ['outer', 'allow_once', 0], ['outer:script:1', 'allow_once', 0], ['outer:script:2', 'deny', 1],
    ] as const) {
      await vi.waitFor(() => expect(events.some(event => event.type === 'permission_required' && event.toolCallId === id)).toBe(true))
      expect(leaf).toHaveBeenCalledTimes(executed)
      broker.resolve('stream', id, decision)
    }
    await result
    expect(leaf).toHaveBeenCalledOnce()
  })

  it('does not hold the branch queue and retains a conflicting overwrite separately', async () => {
    let finish!: (value: unknown) => void
    const { run, leaf } = setup(async () => new Promise(resolve => { finish = resolve }))
    await run({ action: 'exec', code: 'var destination = "old";' })
    const pending = run(script(`return await tools.call('read_file');`, { assign: 'destination', overwrite: true }))
    try {
      await vi.waitFor(() => expect(leaf).toHaveBeenCalledOnce())
      await run({ action: 'exec', code: 'destination = "sibling";' }, { replOwnerId: 'child' })
      await expect(run({ action: 'reset' })).rejects.toThrow('in flight')
    } finally { finish?.('new') }
    const result = await pending
    expect(result).toMatchObject({ status: 'conflict', variable: 'destination' })
    expect((await run({ action: 'show', variable: 'destination' })).content).toBe('sibling')
    expect((await run({ action: 'show', variable: result.resultVariable })).content).toBe('new')
  })

  it('stops waiting on cancellation and never dispatches or stores late follow-up results', async () => {
    let finish!: (value: unknown) => void
    const { run, leaf } = setup(async () => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = run(script(`await tools.call('read_file'); return await tools.call('read_file');`, { assign: 'destination' }), { signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(leaf).toHaveBeenCalledOnce())
    controller.abort()
    await rejection
    finish('late')
    expect((await run({ action: 'list' })).variables).toEqual([])
    expect(leaf).toHaveBeenCalledOnce()
    await run({ action: 'reset' })
  })

  it('bounds calls, promise jobs and CPU, without dispatching concurrent or unawaited calls', async () => {
    const { run, leaf } = setup()
    await expect(run(script(`tools.call('read_file');`))).rejects.toThrow('unawaited')
    await expect(run(script(`await Promise.all([tools.call('read_file'), tools.call('read_file')]);`))).rejects.toThrow('await each')
    await expect(run(script(`await new Promise(() => {});`))).rejects.toThrow('no pending tool call')
    await expect(run(script(`await tools.call('read_file', { path: 'x'.repeat(70_000) });`))).rejects.toThrow()
    await expect(run(script(`for (;;) await Promise.resolve();`, { timeoutMs: 250 }))).rejects.toThrow('promise job budget')
    await expect(run(script(`while (true) {}`, { timeoutMs: 10 }))).rejects.toThrow('CPU budget')
    expect(leaf).not.toHaveBeenCalled()
    await expect(run(script(`for (let i = 0; i < 9; i++) await tools.call('read_file');`, { timeoutMs: 250 }))).rejects.toThrow('at most 8 tool calls')
    expect(leaf).toHaveBeenCalledTimes(8)
  })

  it('bounds concurrent scripts across branches and releases slots after cancellation', async () => {
    const { run, leaf } = setup(async (_call, context) => new Promise((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true })
    }))
    const code = script(`await tools.call('read_file');`)
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    const pending = controllers.map((controller, index) => run(code, { lineageId: `script-${index}`, signal: controller.signal }).catch(error => error))
    try {
      await vi.waitFor(() => expect(leaf).toHaveBeenCalledTimes(4))
      await expect(run(code, { lineageId: 'overflow' })).rejects.toThrow('in-flight script limit')
      controllers[0].abort()
      expect(await pending[0]).toMatchObject({ name: 'AbortError' })
      expect(await run(script('return 1;', { assign: 'result' }), { lineageId: 'overflow' })).toMatchObject({ status: 'stored' })
    } finally {
      for (const controller of controllers) controller.abort()
      await Promise.all(pending)
    }
  })

  it('releases the destination after a thrown ripgrep dispatch and does not retry it', async () => {
    const { run, leaf } = setup(async () => { throw new Error('search failed') })
    await expect(run(script(`return await tools.call('ripgrep', { pattern: 'TODO' });`, { assign: 'result' }), {
      allowedToolNames: new Set(['ripgrep']),
    })).rejects.toThrow('search failed')
    expect(leaf).toHaveBeenCalledOnce()
    expect(leaf.mock.calls[0][0]).toMatchObject({ name: 'ripgrep', arguments: { pattern: 'TODO' } })
    expect(await run(script('return 1;', { assign: 'result' }))).toMatchObject({ status: 'stored' })
  })

  it('validates destinations before dispatch and does not disclose guest-thrown tool data', async () => {
    const { run, leaf } = setup()
    await run({ action: 'exec', code: 'var present = 1;' })
    await expect(run(script(`await tools.call('read_file');`, { assign: 'present' }))).rejects.toThrow('overwrite')
    await expect(run(script(`await tools.call('read_file');`, { show: 'present' }))).rejects.toThrow('separate show')
    expect(leaf).not.toHaveBeenCalled()
    await expect(run(script(`throw (await tools.call('read_file')).content;`, { assign: 'discarded' }))).rejects.toThrow(/^REPL script failed;/)
    expect((await run({ action: 'list' })).variables).toEqual([{ variable: 'present', type: 'number' }])
  })
})


describe('capturing multi_call', () => {
  const batch = (args: Record<string, unknown>) => ({ action: 'invoke', tool: 'multi_call', assign: 'batch', args })

  it('captures parallel results in input order and omits ephemeral modelContent', async () => {
    const { run, leaf } = setup(async call => ({ persistedContent: call.name, modelContent: 'not for capture' }))
    const receipt = await run(batch({ parallel: true, calls: [{ tool: 'read_file' }, { toolName: 'browse_web' }] }))
    expect(receipt).toMatchObject({ status: 'stored', variable: 'batch', toolStatus: 'success' })
    expect(JSON.stringify(receipt)).not.toContain('persistedContent')
    expect(JSON.parse((await run({ action: 'show', variable: 'batch' })).content)).toEqual({
      parallel: true, stopOnError: true, results: [
        { tool: 'read_file', ok: true, data: { persistedContent: 'read_file' } },
        { tool: 'browse_web', ok: true, data: { persistedContent: 'browse_web' } },
      ],
    })
    expect(leaf).toHaveBeenCalledTimes(2)
  })

  it('enforces the caller allowlist, Chat mode and direct-only restrictions on batch members', async () => {
    const { run, leaf } = setup()
    const allowedToolNames = new Set(['multi_call', 'read_file', 'edit_file', 'theme_manager', 'view_image', 'repl', 'plan_md'])
    const calls = ['repl', 'view_image', 'missing', 'edit_file', 'theme_manager', 'read_file'].map(tool => ({ tool }))
    expect(await run(batch({ stopOnError: false, calls }), { allowedToolNames, operationMode: 'plan' })).toMatchObject({ status: 'stored' })
    const { results } = JSON.parse((await run({ action: 'show', variable: 'batch' })).content)
    expect(results.map((entry: any) => entry.ok)).toEqual([false, false, false, false, false, true])
    expect(leaf).toHaveBeenCalledOnce()
    expect(leaf.mock.calls[0][0].name).toBe('read_file')
    expect(await run({ ...batch({ calls: [{ tool: 'read_file' }] }), overwrite: true }, {
      allowedToolNames: new Set(['read_file']),
    })).toMatchObject({ toolStatus: 'error' })
    expect(leaf).toHaveBeenCalledOnce()
  })

  it('blocks batch recursion in both directions but keeps multi_call → repl for leaf captures', async () => {
    const { run, dispatch, context, leaf } = setup()
    expect(await run(batch({ calls: [{ tool: 'multi_call', args: { calls: [{ tool: 'read_file' }] } }] })))
      .toMatchObject({ toolStatus: 'error' })
    const result = await dispatch({ id: 'outer', name: 'multi_call', arguments: { calls: [
      { tool: 'repl', args: { ...batch({ calls: [{ tool: 'read_file' }] }), assign: 'recursive' } },
      { tool: 'repl', args: capture },
    ] } }, context)
    expect(result.results.map((entry: any) => entry.data.toolStatus)).toEqual(['error', 'success'])
    expect((await run({ action: 'show', variable: 'recursive' })).content).toContain('cannot invoke nested tool: multi_call')
    expect(leaf).toHaveBeenCalledOnce()
  })

  it('prompts for each batch member and stores denials and skipped calls', async () => {
    const { dispatch, run, context, leaf } = setup()
    const broker = new DecisionBroker()
    broker.initSession('stream', { autoApproveAll: false })
    const execute = createChatPausingExecutor({ base: dispatch, broker, streamId: 'stream', emit: vi.fn() })
    const pending = execute({ id: 'outer', name: 'repl', arguments: batch({ calls: [{ tool: 'read_file' }, { tool: 'browse_web' }] }) },
      { ...context, nestedExecutor: undefined })
    await vi.waitFor(() => expect(broker.hasPending('stream', 'outer')).toBe(true))
    broker.resolve('stream', 'outer', 'allow_once')
    await vi.waitFor(() => expect(broker.hasPending('stream', 'outer:invoke:1')).toBe(true))
    broker.resolve('stream', 'outer:invoke:1', 'deny')
    await expect(pending).resolves.toMatchObject({ status: 'stored' })
    expect(leaf).not.toHaveBeenCalled()
    const { results } = JSON.parse((await run({ action: 'show', variable: 'batch' })).content)
    expect(results).toMatchObject([{ tool: 'read_file', ok: false, error: 'Tool execution denied by user' },
      { tool: 'browse_web', ok: false, skipped: true }])
  })

  it('rechecks REPL restrictions after a per-member hook rewrites inputs', async () => {
    const { dispatch, run, context, leaf } = setup()
    const broker = new DecisionBroker()
    broker.initSession('stream', { autoApproveAll: true })
    const hookSession = {
      runPreToolUse: vi.fn(async call => call.name === 'plan_md' ? { updatedInput: { action: 'display' } } : {}),
      runPostToolUse: vi.fn(), runPostToolUseFailure: vi.fn(),
    } as unknown as ChatHookSession
    const execute = createChatPausingExecutor({ base: dispatch, broker, streamId: 'stream', emit: vi.fn(), hookSession })
    await execute({ id: 'outer', name: 'repl', arguments: batch({ calls: [{ tool: 'plan_md', args: { action: 'list' } }] }) },
      { ...context, allowedToolNames: new Set(['multi_call', 'plan_md']), nestedExecutor: undefined })
    const { results } = JSON.parse((await run({ action: 'show', variable: 'batch' })).content)
    expect(results[0]).toMatchObject({ tool: 'plan_md', ok: false, error: expect.stringContaining('Use plan_md directly') })
    expect(leaf).not.toHaveBeenCalled()
  })

  it('cancels an in-flight batch without storing late results or starting later calls', async () => {
    let finish!: () => void
    const { run, leaf } = setup(() => new Promise<void>(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = run(batch({ calls: [{ tool: 'read_file' }, { tool: 'browse_web' }] }), { signal: controller.signal })
    await vi.waitFor(() => expect(leaf).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toThrow()
    finish()
    expect(await run({ action: 'list' })).toMatchObject({ variables: [], pendingCaptures: [] })
    expect(leaf).toHaveBeenCalledOnce()
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
