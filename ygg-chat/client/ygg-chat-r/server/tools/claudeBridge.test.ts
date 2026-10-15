import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeBridge } from './claudeBridge.js'
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
    bridge = new ClaudeBridge(() => directory, launch as unknown as typeof spawn, () => '/fake/claude')
    context = { rootPath: directory, conversationId: 'chat-a' }
  })
  afterEach(async () => {
    await bridge.shutdown()
    fs.rmSync(directory, { recursive: true, force: true })
    vi.useRealTimers()
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
    const restored = new ClaudeBridge(() => directory, launch as unknown as typeof spawn)
    expect((await restored.execute({ action: 'list' }, context)).sessions[0].sessionId).toBe(first.sessionId)
    await restored.execute({ action: 'send', sessionId: first.sessionId, message: 'Follow up' }, context)
    const restart = new ClaudeBridge(() => directory, launch as unknown as typeof spawn)
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

  it('bounds waits independently without stopping the job', async () => {
    vi.useFakeTimers()
    const first = await bridge.execute({ action: 'start', message: 'Review' }, context)
    const waiting = bridge.execute({ action: 'wait', sessionId: first.sessionId, waitMs: 50 }, context)
    await vi.advanceTimersByTimeAsync(51)
    expect((await waiting).job.status).toBe('running')
    children[0].reply(first.sessionId)
    expect((await bridge.execute({ action: 'wait', sessionId: first.sessionId }, context)).job.status).toBe('completed')
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
      let result
      do {
        result = await bridge.execute({ action: 'wait', sessionId, waitMs: 30000 }, context)
      } while (result.job?.status === 'running')
      expect(result.job?.status, JSON.stringify(result)).toBe('completed')
    }
    try {
      const first = await bridge.execute({ action: 'start', message: 'Read review.txt in this directory using Read and reply with its exact contents. Do not modify anything.', timeoutMs: 60000 }, context)
      expect(first.success).toBe(true)
      await waitForJob(first.sessionId)
      const next = await bridge.execute({ action: 'send', sessionId: first.sessionId, message: 'Without using tools, repeat the file contents from our previous turn.', timeoutMs: 60000 }, context)
      expect(next.success).toBe(true)
      await waitForJob(first.sessionId)
      const transcript = await bridge.execute({ action: 'read', sessionId: first.sessionId }, context)
      expect(transcript.messageCount).toBe(4)
      expect(transcript.content.split(marker).length).toBeGreaterThanOrEqual(3)
      expect(fs.readFileSync(path.join(directory, 'review.txt'), 'utf8')).toBe(marker)
    } finally {
      await bridge.shutdown()
      fs.rmSync(directory, { recursive: true, force: true })
      fs.rmSync(data, { recursive: true, force: true })
    }
  }, 150000)
})
