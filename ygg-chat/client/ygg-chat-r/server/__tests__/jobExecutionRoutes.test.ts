import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Express } from 'express'

const orchestrator = vi.hoisted(() => ({ submit: vi.fn(), getJob: vi.fn(), cancel: vi.fn() }))
vi.mock('../tools/orchestrator/index.js', () => ({ toolOrchestrator: orchestrator }))
vi.mock('../tools/customToolLoader.js', () => ({ customToolRegistry: {} }))

import { registerJobRoutes } from '../routes/jobRoutes.js'
import { registerToolExecutionRoutes } from '../routes/toolExecutionRoutes.js'

function harness(body: Record<string, unknown>) {
  const routes = new Map<string, (...args: any[]) => any>()
  const app = {
    post: (path: string, handler: (...args: any[]) => any) => routes.set(path, handler),
    get: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  }
  registerToolExecutionRoutes(app as unknown as Express)
  registerJobRoutes(app as unknown as Express)
  const res = Object.assign(new EventEmitter(), { json: vi.fn(), status: vi.fn().mockReturnThis() })
  return { routes, res, run: () => routes.get('/api/jobs/execute-and-wait')!({ body }, res) }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('job-backed UI execution', () => {
  it('removes direct execution but retains custom-tool management', () => {
    const { routes } = harness({})
    expect(routes.has('/api/tools/execute')).toBe(false)
    expect(routes.has('/api/custom-tools/add')).toBe(true)
    expect(routes.has('/api/custom-tools/reload')).toBe(true)
  })

  it.each(['theme_manager', 'bash', 'custom-test', 'mcp__example__tool'])('submits %s once and returns its payload', async toolName => {
    const result = { success: true, output: 'tool-result' }
    const job = { id: 'job-1', status: 'completed', result }
    orchestrator.submit.mockReturnValue(job)
    orchestrator.getJob.mockReturnValue(job)
    const { run, res } = harness({ toolName, args: { action: 'list' } })
    await run()
    expect(orchestrator.submit).toHaveBeenCalledOnce()
    expect(orchestrator.submit).toHaveBeenCalledWith(toolName, { action: 'list' }, { timeoutMs: 300000 })
    expect(res.json).toHaveBeenCalledWith({ success: true, job, result })
  })

  it('keeps running when the caller disconnects (existing behavior)', async () => {
    vi.useFakeTimers()
    orchestrator.submit.mockReturnValue({ id: 'job-1' })
    orchestrator.getJob.mockReturnValue({ id: 'job-1', status: 'running' })
    const { run, res } = harness({ toolName: 'bash', args: { command: 'echo ok' } })
    const running = run()
    res.emit('close')
    expect(orchestrator.cancel).not.toHaveBeenCalled()
    const job = { id: 'job-1', status: 'completed', result: { success: true, stdout: 'ok' } }
    orchestrator.getJob.mockReturnValue(job)
    await vi.advanceTimersByTimeAsync(100)
    await running
    expect(orchestrator.cancel).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, job, result: job.result })
  })

  it.each(['failed', 'cancelled'])('returns a %s job error', async status => {
    const job = { id: 'job-1', status, error: 'handler failed' }
    orchestrator.submit.mockReturnValue(job)
    orchestrator.getJob.mockReturnValue(job)
    const { run, res } = harness({ toolName: 'theme_manager' })
    await run()
    expect(res.json).toHaveBeenCalledWith({ success: false, job, error: status === 'failed' ? job.error : 'Job was cancelled' })
  })

  it('still cancels on its existing wait timeout', async () => {
    vi.useFakeTimers()
    orchestrator.submit.mockReturnValue({ id: 'job-1' })
    orchestrator.getJob.mockReturnValue({ id: 'job-1', status: 'running' })
    const { run, res } = harness({ toolName: 'bash', timeoutMs: 100 })
    const running = run()
    await vi.advanceTimersByTimeAsync(100)
    await running
    expect(orchestrator.cancel).toHaveBeenCalledWith('job-1')
    expect(res.status).toHaveBeenCalledWith(408)
  })
})
