import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateClaudeHook } from '../claudeHookGeneration.js'

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined })
  let stdin = ''
  child.stdin.on('data', chunk => { stdin += chunk.toString() })
  const launch = vi.fn(() => child)
  return { child, launch, stdin: () => stdin }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
describe('isolated Claude hook print process', () => {
  it('uses tool-free ephemeral settings, stdin, filtered env and cleans the private prompt file', async () => {
    vi.stubEnv('UNRELATED_PRIVATE_TOKEN', 'not-inherited')
    const f = fixture()
    const content = '/run-untrusted-command\nprivate text'
    const pending = generateClaudeHook({ content, systemPrompt: 'private system prompt', model: '', signal: new AbortController().signal }, { executable: async () => '/cli', launch: f.launch as any })
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    const [binary, args, options] = f.launch.mock.calls[0] as any
    expect(binary).toBe('/cli')
    expect(args).toEqual(expect.arrayContaining(['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '--disable-slash-commands', '--restricted']))
    expect(args.join(' ')).not.toContain(content)
    expect(args.join(' ')).not.toContain('private system prompt')
    expect(args).not.toContain('--bare') // Bare mode disables subscription OAuth.
    expect(args).not.toContain('--resume')
    expect(options.shell).toBe(false)
    expect(options.env.UNRELATED_PRIVATE_TOKEN).toBeUndefined()
    const settings = JSON.parse(args[args.indexOf('--settings') + 1])
    expect(settings).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: ['**', '**/.*/**'] })
    const systemFile = args[args.indexOf('--system-prompt-file') + 1]
    expect(readFileSync(systemFile, 'utf8')).toBe('private system prompt')
    expect(f.stdin()).toBe(content)
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: '{"note":"yes"}', modelUsage: { 'claude-native': {} } }))
    f.child.emit('close', 0)
    await expect(pending).resolves.toEqual({ text: '{"note":"yes"}', modelName: 'claude-native' })
    expect(existsSync(options.cwd)).toBe(false)
  })
  it.each(['bad-json', 'error-result', 'empty', 'nonzero', 'oversize', 'spawn-error'])('fails safely on %s', async scenario => {
    const f = fixture()
    const pending = generateClaudeHook({ content: 'private', systemPrompt: '', model: 'sonnet', signal: new AbortController().signal }, { executable: async () => '/cli', launch: f.launch as any })
    const rejected = expect(pending).rejects.toThrow(/Claude|start/)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    if (scenario === 'spawn-error') f.child.emit('error', new Error('private secret'))
    else {
      const value = scenario === 'bad-json' ? 'private secret' : scenario === 'oversize' ? 'x'.repeat(300000)
        : JSON.stringify({ type: 'result', subtype: scenario === 'error-result' ? 'error' : 'success', result: scenario === 'empty' ? '' : 'text' })
      f.child.stdout.write(value)
      f.child.emit('close', scenario === 'nonzero' ? 1 : 0)
    }
    await rejected
    expect(existsSync((f.launch.mock.calls[0] as any)[2].cwd)).toBe(false)
  })
  it('requests schema-validated output and returns structured_output', async () => {
    const f = fixture()
    const jsonSchema = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] }
    const pending = generateClaudeHook({ content: 'c', systemPrompt: '', model: 'haiku', signal: new AbortController().signal, jsonSchema }, { executable: async () => '/cli', launch: f.launch as any })
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    const args = (f.launch.mock.calls[0] as any)[1]
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1])).toEqual(jsonSchema)
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: '', structured_output: { note: 'n' } }))
    f.child.emit('close', 0)
    await expect(pending).resolves.toEqual({ text: '{"note":"n"}', modelName: 'haiku', structured: { note: 'n' } })
  })
  it('rejects a schema request when the CLI omits structured_output', async () => {
    const f = fixture()
    const pending = generateClaudeHook({ content: 'c', systemPrompt: '', model: '', signal: new AbortController().signal, jsonSchema: { type: 'object' } }, { executable: async () => '/cli', launch: f.launch as any })
    const rejected = expect(pending).rejects.toThrow(/invalid or empty/)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    expect((f.launch.mock.calls[0] as any)[1]).toContain('--json-schema')
    f.child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: '{"note":"prose"}' }))
    f.child.emit('close', 0)
    await rejected
  })
  it('terminates on abort even if the child never reports close', async () => {
    const f = fixture()
    const controller = new AbortController()
    const pending = generateClaudeHook({ content: 'test', systemPrompt: '', model: '', signal: controller.signal }, { executable: async () => '/cli', launch: f.launch as any })
    const rejected = expect(pending).rejects.toMatchObject({ status: 504 })
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    controller.abort()
    await rejected
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL')
  })
  it('reports a missing CLI without leaking resolver details', async () => {
    await expect(generateClaudeHook({ content: 'test', systemPrompt: '', model: '', signal: new AbortController().signal }, { executable: async () => { throw new Error('private path') } })).rejects.toMatchObject({ status: 503 })
  })
  it.skipIf(process.env.CLAUDE_HOOK_LIVE_TEST !== '1')('live: restricted CLI honors --json-schema', async () => {
    const jsonSchema = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false }
    const result = await generateClaudeHook({ content: 'Write a three-word note about testing.', systemPrompt: 'Respond with the requested note.', model: 'haiku', signal: AbortSignal.timeout(35000), jsonSchema })
    expect(typeof result.structured?.note).toBe('string')
    expect(JSON.parse(result.text)).toEqual(result.structured)
  }, 40000)
  it.skipIf(process.env.CLAUDE_HOOK_LIVE_TEST !== '1')('live: signed-in CLI generates JSON without tools or persistent session', async () => {
    const result = await generateClaudeHook({ content: 'Return only {"note":"synthetic smoke"}. Do not use any tools.', systemPrompt: 'Return exactly the requested JSON.', model: 'haiku', signal: AbortSignal.timeout(35000) })
    expect(JSON.parse(result.text)).toEqual({ note: 'synthetic smoke' })
    expect(result.modelName).not.toBe('default')
  }, 40000)
})
