import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Express } from 'express'

const customRegistry = vi.hoisted(() => ({ hasCustomTool: vi.fn(() => false), executeTool: vi.fn() }))
vi.mock('../tools/customToolLoader.js', () => ({ customToolRegistry: customRegistry }))
vi.mock('../mcp/mcpManager.js', () => ({ mcpManager: {} }))

import { registerToolExecutionRoutes } from '../routes/toolExecutionRoutes.js'

function harness(executeTool?: ReturnType<typeof vi.fn>, toolName = 'bash', custom = false) {
  const routes = new Map<string, (...args: any[]) => Promise<void>>()
  const app = {
    post: (path: string, handler: (...args: any[]) => Promise<void>) => routes.set(path, handler),
    get: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  }
  const handler = vi.fn().mockResolvedValue({ success: true, stdout: 'local-output' })
  registerToolExecutionRoutes(app as unknown as Express, {
    builtInTools: custom ? new Map() : new Map([[toolName, handler]]),
    getToolSandbox: () => executeTool ? { executeTool } as any : null,
    isUtilityRuntimeFallbackDisabled: () => false,
    shouldUseUtilityRuntimeForCustomTool: () => custom,
  })
  const res = Object.assign(new EventEmitter(), { writableEnded: false, json: vi.fn() })
  const run = () => routes.get('/api/tools/execute')!({ body: { toolName, args: { command: 'echo ok' } } }, res)
  return { handler, res, run }
}

describe('direct shell execution lifecycle', () => {
  it.each(['bash', 'edit_file'])('never reruns %s after an uncertain utility failure', async toolName => {
    const executeTool = vi.fn().mockRejectedValue(new Error('Utility runtime request timed out'))
    const { handler, res, run } = harness(executeTool, toolName)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await run()
      expect(handler).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({ result: { success: false, error: 'Utility runtime request timed out' } })
    } finally {
      log.mockRestore()
    }
  })

  it('does not replay a custom tool after disconnect cancellation', async () => {
    customRegistry.hasCustomTool.mockReturnValue(true)
    customRegistry.executeTool.mockClear()
    const executeTool = vi.fn((_name, _args, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', dispatched: true })))
    }))
    const { res, run } = harness(executeTool, 'custom-test', true)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const running = run()
      res.emit('close')
      await running
      expect(customRegistry.executeTool).not.toHaveBeenCalled()
    } finally {
      customRegistry.hasCustomTool.mockReturnValue(false)
      log.mockRestore()
    }
  })

  it('returns captured timeout output without falling back', async () => {
    const result = { success: false, timedOut: true, stdout: 'partial', stderr: '', error: 'Command timed out' }
    const executeTool = vi.fn().mockResolvedValue(result)
    const { handler, res, run } = harness(executeTool)
    await run()
    expect(res.json).toHaveBeenCalledWith({ result })
    expect(handler).not.toHaveBeenCalled()
    expect(res.listenerCount('close')).toBe(0)
  })

  it('aborts local shell execution when the response disconnects', async () => {
    const { handler, res, run } = harness()
    let signal: AbortSignal | undefined
    handler.mockImplementation((_args, options) => {
      signal = options.signal
      return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ success: false, cancelled: true })))
    })
    const running = run()
    expect(signal?.aborted).toBe(false)
    res.emit('close')
    await running
    expect(signal?.aborted).toBe(true)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('does not abort a normally completed response', async () => {
    const { handler, res, run } = harness()
    let signal: AbortSignal | undefined
    handler.mockImplementation((_args, options) => {
      signal = options.signal
      res.writableEnded = true
      res.emit('close')
      return Promise.resolve({ success: true })
    })
    await run()
    expect(signal?.aborted).toBe(false)
  })
})
