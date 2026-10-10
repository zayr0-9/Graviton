import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { ReplSessions, createReplDispatchExecutor } from '../replExecutor.js'
import { createTextFile } from '../../../tools/createFile.js'
import { readTextFile } from '../../../tools/readFile.js'
import { assertToolAllowedForOperationMode, assertToolAllowedWithoutAutoApprove, requiresAgentMode } from '../../../../../../shared/operationModeToolPolicy.js'
import type { ToolExecutionContext, ToolExecutor } from '../toolLoopService.js'

const stores: ReplSessions[] = []
const dirs: string[] = []
afterEach(async () => {
  stores.splice(0).forEach(store => store.clear())
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})
function setup(nested: ToolExecutor = async () => ({ success: true })) {
  const sessions = new ReplSessions()
  stores.push(sessions)
  const leaf = vi.fn(nested)
  const dispatch = createReplDispatchExecutor(leaf, sessions)
  const context: ToolExecutionContext = { conversationId: 'c', lineageId: 'l', messageId: 'm', operationMode: 'execute',
    allowedToolNames: new Set(['read_file', 'create_file']), nestedExecutor: leaf }
  let id = 0
  return { sessions, leaf, run: (args: any, overrides: Partial<ToolExecutionContext> = {}) =>
    dispatch({ id: `${++id}`, name: 'repl', arguments: args }, { ...context, ...overrides }) }
}
const exp = { action: 'export', variable: 'data', path: 'results/data.json' }
const imp = { action: 'import', assign: 'data', path: 'results/data.json' }
const file = (content: string) => ({ success: true, content, sizeBytes: Buffer.byteLength(content), truncated: false })

describe('REPL JSON artifacts', () => {
  it('exports to a real file and restores into a fresh environment without disclosing payload', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repl-artifact-'))
    dirs.push(root)
    const nested: ToolExecutor = async call => {
      const args = call.arguments as any
      return call.name === 'create_file'
        ? createTextFile(args.path, args.content, { cwd: root, overwrite: args.overwrite })
        : { success: true, ...await readTextFile(args.path, { cwd: root, maxBytes: args.maxBytes }) }
    }
    const first = setup(nested)
    await first.run({ action: 'exec', code: 'var data = { marker: "PRIVATE_PAYLOAD", items: [1, null, true, "你好"] };' })
    const exported = await first.run(exp)
    expect(exported).toMatchObject({ success: true, status: 'exported', format: 'json', revision: 1 })
    expect(JSON.stringify(exported)).not.toContain('PRIVATE_PAYLOAD')
    expect(JSON.parse(await fs.readFile(path.join(root, exp.path), 'utf8')).marker).toBe('PRIVATE_PAYLOAD')
    await expect(first.run(exp)).rejects.toThrow('write failed')
    await first.run({ ...exp, overwrite: true })
    first.sessions.clear()
    const second = setup(nested)
    const imported = await second.run(imp, { operationMode: 'plan' })
    expect(imported).toMatchObject({ status: 'imported', variable: 'data', revision: 1 })
    expect(JSON.stringify(imported)).not.toContain('PRIVATE_PAYLOAD')
    expect(JSON.parse((await second.run({ action: 'show', variable: 'data' })).content).marker).toBe('PRIVATE_PAYLOAD')
  })

  it.each(['null', 'true', '42', '"hello"', '[1,2]', '{"__proto__":{"safe":true}}'])('round trips JSON %s', async text => {
    let saved = ''
    const { run } = setup(async call => {
      if (call.name === 'create_file') { saved = (call.arguments as any).content; return { success: true } }
      return file(saved)
    })
    await run({ action: 'exec', code: `var data = JSON.parse(${JSON.stringify(text)});` })
    await run(exp)
    expect(JSON.parse(saved)).toEqual(JSON.parse(text))
    await run({ ...imp, assign: 'restored' })
    expect((await run({ action: 'inspect', variable: 'restored' })).type).toBe(text === 'null' ? 'null' : Array.isArray(JSON.parse(text)) ? 'array' : typeof JSON.parse(text))
  })

  it.each(['undefined', '() => 1', 'NaN', 'Infinity', '1n', 'Symbol("x")', 'new Date()', 'new Map()', '[,1]', '{ nested: undefined }', '({get x() { throw Error("LEAK"); }})', '{toJSON() { throw Error("LEAK"); }}', 'Object.defineProperty({}, "x", {value: 1})', '({[Symbol("x")]:1})', '(() => { var a={}; a.self=a; return a })()'])('rejects unsupported data: %s', async expression => {
    const { run, leaf } = setup()
    await run({ action: 'exec', code: `var data = ${expression};` })
    await expect(run(exp)).rejects.toThrow('Cannot export')
    expect(leaf).not.toHaveBeenCalled()
  })

  it('does not invoke getters or toJSON, including inherited hooks', async () => {
    const { run, leaf } = setup()
    await run({ action: 'exec', code: 'var count=0; var data={get x(){count++;return 1}};' })
    await expect(run(exp)).rejects.toThrow()
    expect((await run({ action: 'show', variable: 'count' })).content).toBe('0')
    await run({ action: 'exec', code: 'data={x:1}; Object.prototype.toJSON=function(){count++;return "BAD"};' })
    await run(exp)
    expect((leaf.mock.calls[0][0].arguments as any).content).toBe('{"x":1}')
    // Remove the hook before using ordinary inspection, which does call JSON hooks.
    await run({ action: 'exec', code: 'delete Object.prototype.toJSON;' })
    expect((await run({ action: 'show', variable: 'count' })).content).toBe('0')
  })

  it('enforces UTF-8 limits, including an exactly 5 MiB artifact', async () => {
    let saved = ''
    const { run, leaf } = setup(async call => {
      if (call.name === 'read_file') return file(saved)
      saved = (call.arguments as any).content
      return { success: true }
    })
    await run({ action: 'exec', code: 'var data="x".repeat(5242878);' })
    expect(await run(exp)).toMatchObject({ sizeBytes: 5242880 })
    await run({ action: 'exec', code: 'data="é".repeat(2621440);' })
    await expect(run(exp)).rejects.toThrow('5 MiB')
    expect(leaf).toHaveBeenCalledTimes(1)
    await run({ action: 'reset' })
    expect(await run(imp)).toMatchObject({ status: 'imported', sizeBytes: 5242880 })
    expect(await run({ action: 'inspect', variable: 'data' })).toMatchObject({ length: 5242878 })
  })

  it.each([
    { ...file('"PRIVATE_PAYLOAD"'), truncated: true },
    file('{PRIVATE_PAYLOAD'),
    { success: false, error: 'PRIVATE_PAYLOAD' },
    { ...file('null'), sizeBytes: 5242881 },
    file('1e999'),
  ])('rejects invalid reads without exposing contents or replacing the destination', async result => {
    const { run } = setup(async () => result)
    await run({ action: 'exec', code: 'var data=1;' })
    try { await run({ ...imp, overwrite: true }); expect.fail('should reject') }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_PAYLOAD') }
    expect((await run({ action: 'show', variable: 'data' })).content).toBe('1')
    expect((await run({ action: 'list' })).pendingCaptures).toEqual([])
  })

  it('accepts BOM and requires explicit destination overwrite before reading', async () => {
    const { run, leaf } = setup(async () => file('\uFEFF{"ok":true}'))
    await run(imp)
    await expect(run(imp)).rejects.toThrow('overwrite')
    expect(leaf).toHaveBeenCalledTimes(1)
    await run({ ...imp, overwrite: true })
  })

  it('preserves import conflict data and prevents reset while a read is pending', async () => {
    let finish!: (value: any) => void
    const { run, leaf } = setup(() => new Promise(resolve => { finish = resolve }))
    await run({ action: 'exec', code: 'var data=1;' })
    const pending = run({ ...imp, overwrite: true })
    await vi.waitFor(() => expect(leaf).toHaveBeenCalled())
    await expect(run({ action: 'reset' })).rejects.toThrow('in flight')
    await run({ action: 'exec', code: 'data=2;' }, { replOwnerId: 'child' })
    finish(file('{"restored":true}'))
    const result = await pending
    expect(result.status).toBe('conflict')
    expect((await run({ action: 'show', variable: 'data' })).content).toBe('2')
    expect((await run({ action: 'show', variable: result.resultVariable })).content).toBe('{"restored":true}')
  })

  it('does not store late cancelled imports and releases the reservation', async () => {
    let finish!: (value: any) => void
    const { run, leaf } = setup(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = run(imp, { signal: controller.signal })
    await vi.waitFor(() => expect(leaf).toHaveBeenCalled())
    controller.abort()
    await expect(pending).rejects.toThrow()
    finish(file('42'))
    expect((await run({ action: 'list' })).pendingCaptures).toEqual([])
    await expect(run({ action: 'show', variable: 'data' })).rejects.toThrow('not found')
  })

  it('snapshots export before sibling mutations without holding the cell during I/O', async () => {
    let finish!: (value: any) => void
    const { run, leaf } = setup(() => new Promise(resolve => { finish = resolve }))
    await run({ action: 'exec', code: 'var data=1;' })
    const pending = run(exp)
    await vi.waitFor(() => expect(leaf).toHaveBeenCalled())
    await run({ action: 'exec', code: 'data=2;' }, { replOwnerId: 'child' })
    finish({ success: true })
    expect(await pending).toMatchObject({ revision: 1, lastWriter: 'main' })
    expect((leaf.mock.calls[0][0].arguments as any).content).toBe('1')
  })

  it('bounds deep data and proxy traps before file dispatch', async () => {
    const { run, leaf } = setup()
    await run({ action: 'exec', code: 'var data={}, cursor=data; for(var i=0;i<70;i++){cursor.next={};cursor=cursor.next;}' })
    await expect(run(exp)).rejects.toThrow('Cannot export')
    await run({ action: 'exec', code: 'data=new Proxy({}, {ownKeys(){while(true){}}});' })
    await expect(run(exp)).rejects.toThrow('Cannot export')
    expect(leaf).not.toHaveBeenCalled()
    await run({ action: 'exec', code: 'data={ok:true};' })
    await run(exp)
    expect(leaf).toHaveBeenCalledTimes(1)
  })

  it('validates names and paths before I/O', async () => {
    const { run, leaf } = setup()
    await expect(run({ ...exp, path: '' })).rejects.toThrow('path')
    await expect(run({ ...exp, overwrite: 'true' })).rejects.toThrow('boolean')
    await expect(run({ ...exp, variable: 'data.value' })).rejects.toThrow('variable name')
    await expect(run(exp)).rejects.toThrow('Cannot export')
    await expect(run({ ...imp, assign: 'JSON' })).rejects.toThrow('Reserved')
    expect(leaf).not.toHaveBeenCalled()
  })

  it('enforces export policy before serialization and preserves help/import access', async () => {
    const { run, leaf } = setup()
    await expect(run(exp, { operationMode: 'plan' })).rejects.toThrow('Chat Mode')
    await expect(run(exp, { replOwnerId: 'child', autoApprove: false })).rejects.toThrow('auto-approve')
    await expect(run(exp, { allowedToolNames: new Set(['read_file']) })).rejects.toThrow('not available')
    await expect(run(exp, { nestedExecutor: undefined })).rejects.toThrow('nested executor')
    expect(leaf).not.toHaveBeenCalled()
    for (const args of [exp, JSON.stringify(exp)]) {
      const call = { name: 'repl', arguments: args }
      expect(requiresAgentMode(call, 'plan')).toBe(true)
      expect(() => assertToolAllowedForOperationMode(call, 'plan')).toThrow('Chat Mode')
      expect(() => assertToolAllowedWithoutAutoApprove(call)).toThrow('auto-approve')
    }
    expect(requiresAgentMode({ name: 'repl', arguments: imp }, 'plan')).toBe(false)
    expect(requiresAgentMode({ name: 'repl', arguments: { ...exp, howto: true } }, 'plan')).toBe(false)
  })
})
