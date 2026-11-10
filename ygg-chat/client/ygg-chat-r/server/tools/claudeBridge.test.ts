import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeBridge } from './claudeBridge.js'
import { ClaudeSessionStore } from './claudeSessionStore.js'
import { withToolAccess } from '../toolAccessContext.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../shared/builtinToolDefinitions.js'
import { assertToolAllowedWithoutAutoApprove, requiresAgentMode } from '../../../../shared/operationModeToolPolicy.js'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null)); return true })
  reply(sessionId: string, text = 'Review complete', code = 0) {
    this.stdout.write(JSON.stringify({ type: 'result', session_id: sessionId, result: text, is_error: false }))
    this.emit('close', code)
  }
}

describe('claude_bridge', () => {
  let directory: string
  let bridge: ClaudeBridge
  let children: FakeChild[]
  let launch: ReturnType<typeof vi.fn>
  let context: { rootPath: string; conversationId: string }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-'))
    children = []
    launch = vi.fn(() => { const child = new FakeChild(); children.push(child); return child })
    bridge = new ClaudeBridge(() => directory, launch as unknown as typeof spawn, () => '/fake/claude', new ClaudeSessionStore(() => path.join(directory, 'claude-config')))
    context = { rootPath: directory, conversationId: 'chat-a' }
  })
  afterEach(async () => {
    await bridge.shutdown()
    fs.rmSync(directory, { recursive: true, force: true })
    vi.useRealTimers()
  })

  function external(id: string, name: string, cwd = directory) {
    const project = path.join(directory, 'claude-config', 'projects', 'fixture-project')
    fs.mkdirSync(project, { recursive: true })
    const file = path.join(project, `${id}.jsonl`)
    fs.writeFileSync(file, [
      { type: 'user', sessionId: id, cwd, timestamp: '2026-10-01T10:00:00Z', message: { content: 'Original private user text' } },
      { type: 'assistant', sessionId: id, cwd, timestamp: '2026-10-01T10:01:00Z', message: { content: [{ type: 'text', text: 'Original answer' }, { type: 'thinking', thinking: 'hidden reasoning' }] } },
      { type: 'custom-title', sessionId: id, customTitle: name },
    ].map(record => JSON.stringify(record)).join('\n') + '\n')
    return file
  }

  it('lists documented model choices without inference or claiming account entitlements', async () => {
    const result = await bridge.execute({ action: 'models' }, context)
    expect(result).toMatchObject({ success: true, source: 'documented_catalog', accountAvailabilityVerified: false })
    expect(result.models.map((entry: any) => entry.model)).toEqual(expect.arrayContaining(['default', 'haiku', 'sonnet', 'opus', 'fable']))
    expect(result.models.find((entry: any) => entry.model === 'fable').description).toContain('usage credits')
    expect(launch).not.toHaveBeenCalled()
  })

  it('persists model choices, switches between turns with the same history, and reports CLI model usage', async () => {
    const first = await bridge.execute({ action: 'start', model: 'haiku', message: 'Review' }, context)
    expect(first).toMatchObject({ model: 'haiku', job: { requestedModel: 'haiku' } })
    expect(launch.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'haiku']))
    const overlap = await bridge.execute({ action: 'send', sessionId: first.sessionId, model: 'opus', message: 'Too soon' }, context)
    expect(overlap.success).toBe(false)
    expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).model).toBe('haiku')
    children[0].reply(first.sessionId, 'Haiku answer')
    const switched = await bridge.execute({ action: 'send', sessionId: first.sessionId, model: 'sonnet', message: 'Go deeper' }, context)
    expect(switched.sessionId).toBe(first.sessionId)
    expect(launch.mock.calls[1][1]).toEqual(expect.arrayContaining(['--resume', first.sessionId, '--model', 'sonnet']))
    children[1].stdout.write(JSON.stringify({ type: 'result', session_id: first.sessionId, result: 'Sonnet answer', modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10 } } }))
    children[1].emit('close', 0)
    const status = await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)
    expect(status.job).toMatchObject({ requestedModel: 'sonnet', modelsUsed: ['claude-sonnet-5-5'] })
    const restored = new ClaudeBridge(() => directory, launch as unknown as typeof spawn, () => '/fake/claude', new ClaudeSessionStore(() => path.join(directory, 'claude-config')))
    await restored.execute({ action: 'send', sessionId: first.sessionId, message: 'Continue' }, context)
    expect(launch.mock.calls[2][1]).toEqual(expect.arrayContaining(['--model', 'sonnet']))
    children[2].reply(first.sessionId)
    const transcript = await restored.execute({ action: 'read', sessionId: first.sessionId }, context)
    expect(transcript.content).toContain('Haiku answer')
    expect(transcript.content).toContain('Sonnet answer')
    await restored.execute({ action: 'send', sessionId: first.sessionId, model: 'default', message: 'Use CLI default' }, context)
    expect(launch.mock.calls[3][1]).toEqual(expect.arrayContaining(['--model', 'default']))
    children[3].reply(first.sessionId)
    await restored.shutdown()
  })

  it('saves model selection for deferred starts/resumes/forks and inherits attached fork overrides', async () => {
    const first = await bridge.execute({ action: 'start', model: 'sonnet' }, context)
    expect(launch).not.toHaveBeenCalled()
    await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Review' }, context)
    expect(launch.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'sonnet']))
    children[0].reply(first.sessionId)
    external(first.sessionId, 'Source')
    const selected = await bridge.execute({ action: 'resume', sessionId: first.sessionId, source: 'bridge', model: 'opus' }, context)
    expect(selected.model).toBe('opus')
    expect(launch).toHaveBeenCalledTimes(1)
    const fork = await bridge.execute({ action: 'fork', sessionId: first.sessionId, source: 'bridge' }, context)
    expect(fork.model).toBe('opus')
    await bridge.execute({ action: 'send', sessionId: fork.sessionId, message: 'Review fork' }, context)
    expect(launch.mock.calls[1][1]).toEqual(expect.arrayContaining(['--model', 'opus']))
    children[1].reply(fork.sessionId)
    const id = '11111111-1111-4111-8111-111111111111'
    external(id, 'External')
    const resumed = await bridge.execute({ action: 'resume', sessionId: id, model: 'haiku' }, context)
    expect(resumed.model).toBe('haiku')
    await bridge.execute({ action: 'send', sessionId: id, message: 'Continue external' }, context)
    expect(launch.mock.calls[2][1]).toEqual(expect.arrayContaining(['--resume', id, '--model', 'haiku']))
    children[2].reply(id)
    const overridden = await bridge.execute({ action: 'fork', sessionId: first.sessionId, source: 'bridge', model: 'claude-custom-version', message: 'Explicit fork' }, context)
    expect(launch.mock.calls[3][1]).toEqual(expect.arrayContaining(['--model', 'claude-custom-version']))
    children[3].reply(overridden.sessionId)
    expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).model).toBe('opus')
  })

  it('keeps omitted models compatible and rejects malformed or misplaced model values', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    expect(launch.mock.calls[0][1]).not.toContain('--model')
    children[0].reply(first.sessionId)
    for (const model of ['', ' ', '--dangerously-skip-permissions', 'opus\n--tools Bash', 'opus\n', 'a'.repeat(257), 42]) {
      const result = await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Review', model } as any, context)
      expect(result.success).toBe(false)
    }
    expect((await bridge.execute({ action: 'status', sessionId: first.sessionId, model: 'opus' }, context)).success).toBe(false)
    expect(launch).toHaveBeenCalledTimes(1)
    const explicit = await bridge.execute({ action: 'send', sessionId: first.sessionId, model: 'arn:aws:bedrock:region:account:inference-profile/custom', message: 'Provider ID' }, context)
    expect(explicit.success).toBe(true)
    children[1].reply(first.sessionId, 'Unavailable model', 1)
    const failed = await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)
    expect(failed.job.status).toBe('failed')
    expect(failed.job.error).toContain('model availability')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(failed.job.requestedModel).toBe('arn:aws:bedrock:region:account:inference-profile/custom')
  })

  it('discovers and searches external names across directories without exposing transcripts', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    external(id, 'Authentication review', '/missing/other-project')
    const result = await bridge.execute({ action: 'list', query: 'authentication' }, context)
    expect(result.totalCount).toBe(1)
    expect(result.sessions[0]).toMatchObject({ sessionId: id, name: 'Authentication review', cwd: '/missing/other-project', source: 'claude_cli' })
    expect(JSON.stringify(result)).not.toContain('Original private')
    expect(JSON.stringify(result)).not.toContain('.jsonl')
    expect((await bridge.execute({ action: 'lookup', name: ' AUTHENTICATION   REVIEW ' }, context)).session.sessionId).toBe(id)
    expect(launch).not.toHaveBeenCalled()
  })

  it('never guesses among duplicate names or partial matches', async () => {
    external('11111111-1111-4111-8111-111111111111', 'Authentication review', directory)
    const other = fs.mkdtempSync(path.join(directory, 'other-'))
    external('22222222-2222-4222-8222-222222222222', 'Authentication review', other)
    const duplicate = await bridge.execute({ action: 'resume', name: 'Authentication review', message: 'Review' }, context)
    expect(duplicate.code).toBe('AMBIGUOUS_SESSION')
    expect(duplicate.matches).toHaveLength(2)
    const partial = await bridge.execute({ action: 'resume', name: 'Authentication' }, context)
    expect(partial.code).toBe('SESSION_NOT_FOUND')
    expect(partial.matches).toHaveLength(2)
    const exact = await bridge.execute({ action: 'lookup', name: 'Authentication review', directory: other }, context)
    expect(exact.session.cwd).toBe(fs.realpathSync(other))
    expect(launch).not.toHaveBeenCalled()
  })

  it('resumes existing external IDs and imports only human-readable text', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    external(id, 'Auth review')
    const resumed = await bridge.execute({ action: 'resume', sessionId: id, message: 'Follow up' }, context)
    expect(resumed.success).toBe(true)
    expect(resumed.sessionId).toBe(id)
    expect(launch.mock.calls[0][1]).toContain('--resume')
    children[0].reply(id, 'Follow-up answer')
    const transcript = await bridge.execute({ action: 'read', name: 'Auth review' }, context)
    expect(transcript.content).toContain('Original private user text')
    expect(transcript.content).toContain('Original answer')
    expect(transcript.content).toContain('Follow-up answer')
    expect(transcript.content).not.toContain('hidden reasoning')
    const missing = await bridge.execute({ action: 'resume', sessionId: '99999999-9999-4999-8999-999999999999' }, context)
    expect(missing.code).toBe('SESSION_NOT_FOUND')
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('forks with distinct source/destination IDs and leaves the source history unchanged', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const file = external(id, 'Auth review')
    const original = fs.readFileSync(file, 'utf8')
    const fork = await bridge.execute({ action: 'fork', name: 'Auth review', newName: 'Auth second opinion', message: 'Review independently' }, context)
    expect(fork.success).toBe(true)
    expect(fork.sessionId).not.toBe(id)
    expect(launch.mock.calls[0][1]).toEqual(expect.arrayContaining(['--resume', id, '--fork-session', '--session-id', fork.sessionId, '--name', 'Auth second opinion']))
    children[0].reply(fork.sessionId)
    await bridge.execute({ action: 'send', sessionId: fork.sessionId, message: 'Continue' }, context)
    expect(launch.mock.calls[1][1]).toContain(fork.sessionId)
    expect(launch.mock.calls[1][1]).not.toContain('--fork-session')
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })

  it('requires trusted Full access for cross-workspace resume/fork/read and rechecks on every send', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-other-'))
    const id = '11111111-1111-4111-8111-111111111111'
    external(id, 'Other project review', other)
    try {
      expect((await bridge.execute({ action: 'resume', name: 'Other project review' }, context)).code).toBe('WORKSPACE_ACCESS_REQUIRED')
      expect((await bridge.execute({ action: 'fork', sessionId: id }, context)).code).toBe('WORKSPACE_ACCESS_REQUIRED')
      const attached = await withToolAccess(true, () => bridge.execute({ action: 'resume', sessionId: id }, context))
      expect(attached.success).toBe(true)
      expect((await bridge.execute({ action: 'read', sessionId: id }, context)).code).toBe('WORKSPACE_ACCESS_REQUIRED')
      expect((await bridge.execute({ action: 'send', sessionId: id, message: 'Continue' }, context)).code).toBe('WORKSPACE_ACCESS_REQUIRED')
      const authorized = await withToolAccess(true, () => bridge.execute({ action: 'send', sessionId: id, message: 'Continue' }, context))
      expect(authorized.success).toBe(true)
      expect(launch.mock.calls[0][2].cwd).toBe(fs.realpathSync(other))
      children[0].reply(id)
    } finally { fs.rmSync(other, { recursive: true, force: true }) }
  })

  it('blocks resuming live terminal sessions but permits an independent fork', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    external(id, 'Live review')
    const registry = path.join(directory, 'claude-config', 'sessions')
    fs.mkdirSync(registry, { recursive: true })
    fs.writeFileSync(path.join(registry, `${process.pid}.json`), JSON.stringify({ sessionId: id, cwd: directory, pid: process.pid }))
    expect((await bridge.execute({ action: 'list' }, context)).sessions[0].active).toBe(true)
    expect((await bridge.execute({ action: 'resume', name: 'Live review' }, context)).success).toBe(false)
    const fork = await bridge.execute({ action: 'fork', name: 'Live review', message: 'Independent review' }, context)
    expect(fork.success).toBe(true)
    children[0].reply(fork.sessionId)
  })

  it('forks a completed attached session even when selection uses source:bridge', async () => {
    const first = await bridge.execute({ action: 'start', name: 'Local review', message: 'Review' }, context)
    children[0].reply(first.sessionId)
    external(first.sessionId, 'Local review')
    const fork = await bridge.execute({ action: 'fork', name: 'Local review', source: 'bridge', message: 'Independent opinion' }, context)
    expect(fork.success, JSON.stringify(fork)).toBe(true)
    children[1].reply(fork.sessionId)
  })

  it('refreshes a deferred fork history boundary when its first send materializes it', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const file = external(id, 'Deferred review')
    const fork = await bridge.execute({ action: 'fork', name: 'Deferred review' }, context)
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'New source turn before materialization' } }) + '\n')
    const result = await bridge.execute({ action: 'send', sessionId: fork.sessionId, message: 'Continue fork' }, context)
    expect(result.success, JSON.stringify(result)).toBe(true)
    children[0].reply(fork.sessionId)
    const transcript = await bridge.execute({ action: 'read', sessionId: fork.sessionId }, context)
    expect(transcript.content).toContain('New source turn before materialization')
  })

  it('rejects overlap before an async registry lookup can lose a just-completed response', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    children[0].reply(first.sessionId, 'First answer')
    await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Second' }, context)
    const rejected = bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Third' }, context)
    children[1].reply(first.sessionId, 'Second answer must survive')
    expect((await rejected).success).toBe(false)
    expect((await bridge.execute({ action: 'read', sessionId: first.sessionId }, context)).content).toContain('Second answer must survive')
  })

  it('does not launch a request whose preparation overlapped server shutdown', async () => {
    const store = new ClaudeSessionStore(() => path.join(directory, 'claude-config'))
    let release!: (ids: Set<string>) => void
    vi.spyOn(store, 'activeSessionIds').mockImplementation(() => new Promise(resolve => { release = resolve }))
    const service = new ClaudeBridge(() => directory, launch as unknown as typeof spawn, () => '/fake/claude', store)
    const pending = service.execute({ action: 'start', message: 'Review' }, context)
    await service.shutdown()
    release(new Set())
    expect((await pending).success).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not let another attached conversation cancel the current owner’s job', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    external(id, 'Shared history')
    await bridge.execute({ action: 'resume', sessionId: id }, context)
    const other = { ...context, conversationId: 'other-chat' }
    await bridge.execute({ action: 'resume', sessionId: id }, other)
    await bridge.execute({ action: 'send', sessionId: id, message: 'Owned work' }, context)
    const cancellation = await bridge.execute({ action: 'cancel', sessionId: id }, other)
    expect(cancellation.cancellationRequested).toBe(false)
    expect(children[0].kill).not.toHaveBeenCalled()
    children[0].reply(id)
  })

  it('allows read-only review in Chat mode but gates unattended external delegation', () => {
    expect(requiresAgentMode({ name: 'claude_bridge' }, 'plan')).toBe(false)
    expect(() => assertToolAllowedWithoutAutoApprove({ name: 'claude_bridge' })).toThrow('requires auto-approve')
  })

  it('publishes an enabled built-in schema', () => {
    const schema = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'claude_bridge')!
    expect(schema.enabled).toBe(true)
    expect(schema.inputSchema.properties.action.enum).toContain('wait')
  })

  it('starts asynchronously, resumes explicit sessions, and reads a lossless transcript', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review this code' }, context)
    expect(first.job.status).toBe('running')
    const [binary, args, options] = launch.mock.calls[0] as any[]
    expect(binary).toBe('/fake/claude')
    expect(args).toContain('--session-id')
    expect(args).toContain('--restricted')
    expect(args).toContain('Read,Glob,Grep')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('{"disableAllHooks":true}')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('Review this code')
    expect(options.shell).toBe(false)
    expect(options.cwd).toBe(fs.realpathSync(directory))
    expect(children[0].stdin.read().toString()).toBe('Review this code')
    children[0].reply(first.sessionId, 'Found an issue')
    const next = await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Explain it' }, context)
    expect(next.job.status).toBe('running')
    expect(launch.mock.calls[1][1]).toContain('--resume')
    expect(launch.mock.calls[1][1]).toContain(first.sessionId)
    children[1].reply(first.sessionId, 'Explanation')
    const full = await bridge.execute({ action: 'read', sessionId: first.sessionId }, context)
    const a = await bridge.execute({ action: 'read', sessionId: first.sessionId, maxOutputChars: 10 }, context)
    const b = await bridge.execute({ action: 'read', sessionId: first.sessionId, offset: a.nextOffset }, context)
    expect(a.content + b.content).toBe(full.content)
    expect(full.content).toContain('Found an issue')
    expect(full.content).toContain('Explanation')
    expect(full.messageCount).toBe(4)
    expect(full.job.status).toBe('completed')
  })

  it('rejects overlapping sends and isolates conversations, workspaces, and IDs', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    expect((await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Again' }, context)).success).toBe(false)
    expect((await bridge.execute({ action: 'read', sessionId: first.sessionId }, { ...context, conversationId: 'chat-b' })).success).toBe(false)
    expect((await bridge.execute({ action: 'read', sessionId: '../../secret' }, context)).success).toBe(false)
    expect((await bridge.execute({ action: 'list' }, { ...context, conversationId: 'chat-b' })).sessions).toEqual([])
    expect((await bridge.execute({ action: 'start' }, {})).success).toBe(false)
    const other = fs.mkdtempSync(path.join(directory, 'workspace-'))
    expect((await bridge.execute({ action: 'read', sessionId: first.sessionId }, { ...context, rootPath: other })).success).toBe(false)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('persists sessions across service recreation and detects interrupted requests', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    children[0].reply(first.sessionId)
    const restored = new ClaudeBridge(() => directory, launch as unknown as typeof spawn, () => '/fake/claude', new ClaudeSessionStore(() => path.join(directory, 'claude-config')))
    expect((await restored.execute({ action: 'list' }, context)).sessions[0].sessionId).toBe(first.sessionId)
    await restored.execute({ action: 'send', sessionId: first.sessionId, message: 'Follow up' }, context)
    const restart = new ClaudeBridge(() => directory, launch as unknown as typeof spawn, () => '/fake/claude', new ClaudeSessionStore(() => path.join(directory, 'claude-config')))
    expect((await restart.execute({ action: 'status', sessionId: first.sessionId }, context)).job.status).toBe('interrupted')
    await restored.shutdown()
  })

  it('cancels jobs without deleting the conversation', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    await bridge.execute({ action: 'cancel', sessionId: first.sessionId }, context)
    const result = await bridge.execute({ action: 'wait', sessionId: first.sessionId }, context)
    expect(result.job.status).toBe('cancelled')
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect((await bridge.execute({ action: 'list' }, context)).totalCount).toBe(1)
    expect((await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Again' }, context)).success).toBe(false)
  })

  it('handles spawn errors and malformed results without saving stderr', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    children[0].stderr.write('private account diagnostics')
    children[0].emit('error', new Error('ENOENT'))
    expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).job.error).toContain('Could not launch')
    const second = await bridge.execute({ action: 'start', message: 'Review again' }, context)
    children[1].stdout.write('not JSON')
    children[1].emit('close', 1)
    const result = await bridge.execute({ action: 'read', sessionId: second.sessionId }, context)
    expect(result.job.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('private account')
  })

  it('does not resume a failed first JSON result even when its session ID matches', async () => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    children[0].stdout.write(JSON.stringify({ type: 'result', session_id: first.sessionId, is_error: true, result: 'Failed' }))
    children[0].emit('close', 1)
    const next = await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Again' }, context)
    expect(next.success).toBe(false)
    expect(next.error).toContain('first turn')
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('escalates group cleanup even if the leader closes after TERM', async () => {
    vi.useFakeTimers()
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    Object.assign(children[0], { pid: 123456 })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await bridge.execute({ action: 'cancel', sessionId: first.sessionId }, context)
      children[0].emit('close', null)
      expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).job.status).toBe('running')
      await vi.advanceTimersByTimeAsync(2001)
      expect(kill).toHaveBeenCalledWith(-123456, 'SIGKILL')
      expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).job.status).toBe('cancelled')
    } finally {
      kill.mockRestore()
    }
  })

  it('bounds output and job duration', async () => {
    vi.useFakeTimers()
    const first = await bridge.execute({ action: 'start', message: 'Review', timeoutMs: 1000 }, context)
    await vi.advanceTimersByTimeAsync(1001)
    expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).job.error).toContain('timed out')
    const second = await bridge.execute({ action: 'start', message: 'Review' }, context)
    children[1].stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1))
    await Promise.resolve()
    expect((await bridge.execute({ action: 'status', sessionId: second.sessionId }, context)).job.error).toContain('exceeded')
  })

  it('registers a nonblocking runtime wait for the exact job reply, not a subsequent turn', async () => {
    const source = { action: 'start', toolCallId: 'launch-call', messageId: 'launch-message', streamId: 'launch-stream' }
    const first = await bridge.execute({ action: 'start', message: 'Review', source: { toolCallId: 'untrusted' } } as any,
      { ...context, ...source })
    expect(first.job.source).toEqual(source)
    let completion!: Promise<Record<string, any>>
    const registerWait = vi.fn((jobId, result) => { completion = result; return { handle: `watch:${jobId}`, autoResume: true } })
    const waiting = await bridge.execute({ action: 'wait', sessionId: first.sessionId },
      { ...context, toolCallId: 'wait-call', messageId: 'wait-message', registerWait })
    expect(waiting).toMatchObject({ success: true, autoResume: true, job: { status: 'running' } })
    expect(registerWait).toHaveBeenCalledTimes(1)
    children[0].reply(first.sessionId, 'First reply')
    await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Next turn' },
      { ...context, toolCallId: 'second-launch', messageId: 'second-message' })
    children[1].reply(first.sessionId, 'Second reply')
    expect(await completion).toMatchObject({ sessionId: first.sessionId, job: { id: first.job.id, status: 'completed', source }, content: 'First reply' })
    await bridge.execute({ action: 'wait', sessionId: first.sessionId }, { ...context, registerWait })
    expect(registerWait).toHaveBeenCalledTimes(2)
    expect(await completion).toMatchObject({ content: 'Second reply', job: { source: { action: 'send', toolCallId: 'second-launch' } } })
    const restored = new ClaudeBridge(() => directory)
    await restored.execute({ action: 'wait', sessionId: first.sessionId }, { ...context, registerWait })
    expect(await completion).toMatchObject({ content: 'Second reply', job: { source: { action: 'send', toolCallId: 'second-launch' } } })
  })

  it('captures launch provenance for resume/fork with messages and deferred sends', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    external(id, 'Existing review')
    const resumed = await bridge.execute({ action: 'resume', sessionId: id, message: 'Continue' },
      { ...context, toolCallId: 'resume-call' })
    expect(resumed.job.source).toEqual({ action: 'resume', toolCallId: 'resume-call' })
    children[0].reply(id)
    const forked = await bridge.execute({ action: 'fork', sessionId: id, message: 'Independent review' },
      { ...context, toolCallId: 'fork-call' })
    expect(forked.job.source).toEqual({ action: 'fork', toolCallId: 'fork-call' })
    children[1].reply(forked.sessionId)
    const deferred = await bridge.execute({ action: 'start' }, { ...context, toolCallId: 'empty-start' })
    expect(deferred.job).toBeUndefined()
    const sent = await bridge.execute({ action: 'send', sessionId: deferred.sessionId, message: 'Review' },
      { ...context, toolCallId: 'actual-send' })
    expect(sent.job.source).toEqual({ action: 'send', toolCallId: 'actual-send' })
  })

  it('waits for completion without a separate polling timeout', async () => {
    vi.useFakeTimers()
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    let settled = false
    const waiting = bridge.execute({ action: 'wait', sessionId: first.sessionId }, context)
      .then(result => { settled = true; return result })
    await vi.advanceTimersByTimeAsync(30001)
    expect(settled).toBe(false)
    children[0].reply(first.sessionId)
    expect((await waiting).job.status).toBe('completed')
  })

  it.each([false, true])('allows caller cancellation of a wait without stopping the job (already aborted: %s)', async alreadyAborted => {
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    const controller = new AbortController()
    if (alreadyAborted) controller.abort()
    const waiting = bridge.execute({ action: 'wait', sessionId: first.sessionId }, { ...context, signal: controller.signal })
    controller.abort()
    const result = await waiting
    if (alreadyAborted) expect(result).toMatchObject({ success: false, error: 'Request cancelled' })
    else expect(result.job.status).toBe('running')
    expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).job.status).toBe('running')
    children[0].reply(first.sessionId)
    expect((await bridge.execute({ action: 'status', sessionId: first.sessionId }, context)).job.status).toBe('completed')
  })
})

// Opt-in only: uses the installed CLI/account and incurs normal Claude usage.
describe.skipIf(process.env.CLAUDE_BRIDGE_LIVE_TEST !== '1')('Claude bridge live CLI', () => {
  it('reads a workspace file and remembers it across explicit resumed turns', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-live-'))
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-data-'))
    const bridge = new ClaudeBridge(() => data)
    const context = { rootPath: directory, conversationId: 'live-smoke-test' }
    const marker = `bridge-${Date.now()}`
    fs.writeFileSync(path.join(directory, 'review.txt'), marker)
    const waitForJob = async (sessionId: string) => {
      const result = await bridge.execute({ action: 'wait', sessionId }, context)
      expect(result.job?.status, JSON.stringify(result)).toBe('completed')
      expect(result.job.modelsUsed?.length).toBeGreaterThan(0)
      return result
    }
    try {
      const title = `Bridge live ${Date.now()}`
      const first = await bridge.execute({ action: 'start', name: title, model: 'haiku', message: 'Read review.txt in this directory using Read and reply with its exact contents. Do not modify anything.', timeoutMs: 60000 }, context)
      expect(first.success).toBe(true)
      const haiku = await waitForJob(first.sessionId)
      expect(haiku.job.requestedModel).toBe('haiku')
      expect(haiku.job.modelsUsed.some((model: string) => model.includes('haiku'))).toBe(true)
      const next = await bridge.execute({ action: 'send', sessionId: first.sessionId, model: 'sonnet', message: 'Without using tools, repeat the file contents from our previous turn.', timeoutMs: 60000 }, context)
      expect(next.success).toBe(true)
      const sonnet = await waitForJob(first.sessionId)
      expect(sonnet.job.requestedModel).toBe('sonnet')
      expect(sonnet.job.modelsUsed.some((model: string) => model.includes('sonnet'))).toBe(true)
      const transcript = await bridge.execute({ action: 'read', sessionId: first.sessionId }, context)
      expect(transcript.messageCount).toBe(4)
      expect(transcript.content.split(marker).length).toBeGreaterThanOrEqual(3)
      // A different Graviton conversation knows only the human name, not the Claude UUID.
      const externalContext = { ...context, conversationId: 'live-external-import' }
      const found = await bridge.execute({ action: 'lookup', name: title, source: 'claude' }, externalContext)
      expect(found.success, JSON.stringify(found)).toBe(true)
      expect(found.session.sessionId).toBe(first.sessionId)
      const attached = await bridge.execute({ action: 'resume', name: title, source: 'claude' }, externalContext)
      expect(attached.success, JSON.stringify(attached)).toBe(true)
      const imported = await bridge.execute({ action: 'read', sessionId: attached.sessionId }, externalContext)
      expect(imported.content).toContain(marker)
      const fork = await bridge.execute({ action: 'fork', name: title, source: 'claude', newName: `${title} fork`, model: 'opus', message: 'Without tools, repeat the file contents you remember from our earlier conversation.', timeoutMs: 60000 }, externalContext)
      expect(fork.success, JSON.stringify(fork)).toBe(true)
      expect(fork.sessionId).not.toBe(first.sessionId)
      const forkResult = await bridge.execute({ action: 'wait', sessionId: fork.sessionId }, externalContext)
      expect(forkResult.job?.status, JSON.stringify(forkResult)).toBe('completed')
      expect(forkResult.job.modelsUsed.some((model: string) => model.includes('opus'))).toBe(true)
      const forkTranscript = await bridge.execute({ action: 'read', sessionId: fork.sessionId }, externalContext)
      expect(forkTranscript.content).toContain(marker)
      const liveFork = await bridge.execute({ action: 'lookup', sessionId: fork.sessionId, source: 'claude' }, externalContext)
      expect(liveFork.success, JSON.stringify(liveFork)).toBe(true)
      expect(fs.readFileSync(path.join(directory, 'review.txt'), 'utf8')).toBe(marker)
    } finally {
      await bridge.shutdown()
      fs.rmSync(directory, { recursive: true, force: true })
      fs.rmSync(data, { recursive: true, force: true })
    }
  }, 150000)
})
