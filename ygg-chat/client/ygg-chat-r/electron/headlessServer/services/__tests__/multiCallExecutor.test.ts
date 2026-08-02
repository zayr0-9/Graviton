import { describe, expect, it, vi } from 'vitest'
import { createMultiCallDispatchExecutor, executeMultiCall } from '../multiCallExecutor.js'

const context = (overrides: Record<string, any> = {}) => ({
  conversationId: 'conversation-1',
  messageId: 'message-1',
  operationMode: 'execute' as const,
  signal: new AbortController().signal,
  ...overrides,
})

const call = (argumentsValue: Record<string, unknown>) => ({ id: 'batch-1', name: 'multi_call', arguments: argumentsValue })

describe('multiCallExecutor', () => {
  it('executes calls sequentially in order and preserves ordered results', async () => {
    const order: string[] = []
    const execute = vi.fn(async nested => {
      order.push(nested.name)
      return { value: nested.name }
    })

    const result = await executeMultiCall(
      call({ calls: [{ tool: 'read_file', args: { path: 'a' } }, { toolName: 'glob', args: { pattern: '*' } }] }),
      context(),
      execute
    )

    expect(order).toEqual(['read_file', 'glob'])
    expect(result).toEqual({
      parallel: false,
      stopOnError: true,
      results: [
        { tool: 'read_file', ok: true, data: { value: 'read_file' } },
        { tool: 'glob', ok: true, data: { value: 'glob' } },
      ],
    })
    expect(execute.mock.calls[0][0].id).toBe('batch-1:1')
  })

  it('runs parallel calls with bounded concurrency and preserves input order', async () => {
    let active = 0
    let peak = 0
    const execute = vi.fn(async nested => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, nested.name === 'first' ? 20 : 5))
      active -= 1
      return nested.name
    })

    const result = await executeMultiCall(
      call({ calls: ['first', 'second', 'third'].map(tool => ({ tool })), parallel: true, maxConcurrency: 2 }),
      context(),
      execute
    )

    expect(peak).toBe(2)
    expect(result.results.map(item => item.data)).toEqual(['first', 'second', 'third'])
  })

  it('stops sequential execution after an error by default', async () => {
    const execute = vi.fn(async nested => {
      if (nested.name === 'bad') throw new Error('boom')
      return 'ok'
    })

    const result = await executeMultiCall(call({ calls: [{ tool: 'bad' }, { tool: 'never' }] }), context(), execute)

    expect(execute).toHaveBeenCalledOnce()
    expect(result.results).toEqual([
      { tool: 'bad', ok: false, error: 'boom' },
      { tool: 'never', ok: false, skipped: true, error: 'Skipped after an earlier call failed' },
    ])
  })

  it('rejects recursive and UI-rendering nested tools, allows subagent, and enforces nested plan-mode policy', async () => {
    const execute = vi.fn(async nested => nested.name)
    for (const nestedCall of [
      { tool: 'multi_call' },
      { tool: 'html_renderer' },
      { tool: 'plan_md', args: { action: 'display', name: 'sample-plan' } },
    ]) {
      await expect(executeMultiCall(call({ calls: [nestedCall] }), context(), execute)).rejects.toThrow(
        `cannot invoke nested tool: ${nestedCall.tool}`
      )
    }

    const subagentResult = await executeMultiCall(call({ calls: [{ tool: 'subagent' }] }), context(), execute)
    expect(subagentResult.results[0]).toEqual({ tool: 'subagent', ok: true, data: 'subagent' })

    const result = await executeMultiCall(call({ calls: [{ tool: 'edit_file' }] }), context({ operationMode: 'plan' }), execute)
    expect(result.results[0]).toMatchObject({ tool: 'edit_file', ok: false })
    expect(result.results[0].error).toContain('not available in Chat Mode')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('uses the policy-aware nested executor supplied in context', async () => {
    const leaf = vi.fn()
    const nestedExecutor = vi.fn(async nested => nested.name)
    const dispatch = createMultiCallDispatchExecutor(leaf)

    const result = await dispatch(call({ calls: [{ tool: 'read_file' }] }), context({ nestedExecutor }))

    expect(leaf).not.toHaveBeenCalled()
    expect(nestedExecutor).toHaveBeenCalledOnce()
    expect(result.results[0]).toEqual({ tool: 'read_file', ok: true, data: 'read_file' })
  })

  it('does not expose ephemeral nested modelContent in the aggregate result', async () => {
    const result = await executeMultiCall(
      call({ calls: [{ tool: 'view_image' }] }),
      context(),
      vi.fn(async () => ({ displayContent: { path: 'image.png' }, modelContent: [{ type: 'input_image' }] }))
    )

    expect(result.results[0].data).toEqual({ displayContent: { path: 'image.png' } })
  })
})
