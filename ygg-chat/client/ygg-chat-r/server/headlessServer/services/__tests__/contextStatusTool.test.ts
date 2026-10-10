import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../../shared/builtinToolDefinitions.js'
import { requiresAgentMode, assertToolAllowedWithoutAutoApprove } from '../../../../../../shared/operationModeToolPolicy.js'
import { createContextStatusExecutor, type BranchContextStatus } from '../contextStatusTool.js'
import { createMultiCallDispatchExecutor } from '../multiCallExecutor.js'
import { createChatPausingExecutor } from '../chatOrchestrator.js'
import { DecisionBroker } from '../decisionBroker.js'

const status: BranchContextStatus = {
  conversationId: 'conversation', lineageId: 'branch-a', streamId: 'run-a', messageId: 'assistant-a',
  provider: 'openaichatgpt', modelName: 'test-model', usedTokens: 20_000,
  totalContextLimit: 100_000, remainingTokens: 80_000, usedPercent: 20, remainingPercent: 80,
  source: 'reported', recordedAt: '2026-10-06T00:00:00.000Z',
}
const call = { id: 'status-call', name: 'context_status', arguments: {} }
const context = { conversationId: 'conversation', messageId: 'assistant-a', getContextStatus: () => status }

describe('context_status', () => {
  it('is enabled with no required arguments and is read-only in Chat mode', () => {
    const definition = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === call.name)!
    expect(definition.enabled).toBe(true)
    expect(definition.inputSchema.properties).toEqual({})
    expect(requiresAgentMode(call, 'plan')).toBe(false)
    expect(() => assertToolAllowedWithoutAutoApprove(call)).not.toThrow()
  })

  it('uses only the calling run callback, never model-supplied branch/credit values', async () => {
    const leaf = vi.fn()
    const execute = createContextStatusExecutor(leaf)
    const result = await execute({ ...call, arguments: { lineageId: 'branch-b', totalBudget: 1 } }, context)
    expect(result).toEqual({ remainingTokens: 80000, remainingPercent: 80,
      note: 'Approximate snapshot; not guaranteed output capacity.' })
    expect(leaf).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('totalBudget')
    await execute({ ...call, name: 'read_file' }, context)
    expect(leaf).toHaveBeenCalledOnce()
  })

  it('rounds remaining percent to a whole number', async () => {
    const result = await createContextStatusExecutor(vi.fn())(call, {
      ...context, getContextStatus: () => ({ ...status, remainingTokens: 278030, remainingPercent: 60.70524017467249 }),
    })
    expect(result.remainingTokens).toBe(278030)
    expect(result.remainingPercent).toBe(61)
    expect(Object.keys(result).sort()).toEqual(['note', 'remainingPercent', 'remainingTokens'])
  })

  it('fails clearly outside a live run and honors cancellation', async () => {
    const execute = createContextStatusExecutor(vi.fn())
    await expect(execute(call, { conversationId: 'conversation', messageId: 'assistant-a' }))
      .rejects.toThrow('only available inside an active model/tool run')
    const controller = new AbortController()
    controller.abort()
    await expect(execute(call, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('works inside multi_call in Chat mode without prompting for permission', async () => {
    const leaf = vi.fn()
    const broker = new DecisionBroker()
    broker.initSession('run-a', { autoApproveAll: false })
    const events: any[] = []
    const execute = createChatPausingExecutor({
      base: createMultiCallDispatchExecutor(createContextStatusExecutor(leaf)),
      broker, streamId: 'run-a', emit: event => events.push(event),
    })
    const result = await execute({
      id: 'batch', name: 'multi_call', arguments: { calls: [{ tool: 'context_status' }], parallel: true },
    }, { ...context, operationMode: 'plan', autoApprove: false })
    expect(result.results[0]).toMatchObject({ tool: 'context_status', ok: true, data: { remainingTokens: 80000, remainingPercent: 80 } })
    expect(events).toEqual([])
    expect(leaf).not.toHaveBeenCalled()
  })
})
