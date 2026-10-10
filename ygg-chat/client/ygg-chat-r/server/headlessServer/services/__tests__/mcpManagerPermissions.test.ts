import { describe, expect, it, vi } from 'vitest'
import { createChatPausingExecutor } from '../chatOrchestrator.js'
import { DecisionBroker } from '../decisionBroker.js'
import { OperationModeControl } from '../operationModeControl.js'
import { assertToolAllowedWithoutAutoApprove } from '../../../../../../shared/operationModeToolPolicy.js'

const context = { operationMode: 'execute' } as any

describe('MCP manager permissions', () => {
  it('bypasses discovery but prompts for invoke, and denial prevents execution', async () => {
    const broker = new DecisionBroker()
    broker.initSession('mcp-run', { autoApproveAll: false })
    const base = vi.fn().mockResolvedValue({ success: true })
    const events: any[] = []
    const execute = createChatPausingExecutor({ broker, streamId: 'mcp-run', base, emit: event => events.push(event) })
    await execute({ id: 'list', name: 'mcp_manager', arguments: { action: 'list_tools', name: 'demo' } }, context)
    expect(base).toHaveBeenCalledOnce()
    const pending = execute({ id: 'invoke', name: 'mcp_manager', arguments: { action: 'invoke', name: 'demo', tool: 'echo' } }, context)
    expect(events.at(-1)).toMatchObject({ type: 'permission_required', toolName: 'mcp_manager', toolInput: { tool: 'echo' } })
    broker.resolve('mcp-run', 'invoke', 'deny')
    await expect(pending).rejects.toThrow('denied')
    expect(base).toHaveBeenCalledOnce()
  })

  it('allows approved invocation and still requires unattended subagent approval', async () => {
    const broker = new DecisionBroker()
    broker.initSession('mcp-run', { autoApproveAll: false })
    const base = vi.fn().mockResolvedValue({ success: true })
    const execute = createChatPausingExecutor({ broker, streamId: 'mcp-run', base, emit: () => {} })
    const call = { id: 'invoke', name: 'mcp_manager', arguments: { action: 'invoke', name: 'demo', tool: 'echo' } }
    const pending = execute(call, context)
    broker.resolve('mcp-run', 'invoke', 'allow_once')
    await expect(pending).resolves.toEqual({ success: true })
    expect(base).toHaveBeenCalledOnce()
    expect(() => assertToolAllowedWithoutAutoApprove(call)).toThrow('requires auto-approve')
  })

  it('blocks invoke after a live switch to Plan mode during approval', async () => {
    const broker = new DecisionBroker()
    broker.initSession('mcp-run', { autoApproveAll: false })
    const modeControl = new OperationModeControl('execute')
    const base = vi.fn()
    const execute = createChatPausingExecutor({ broker, streamId: 'mcp-run', base, modeControl, emit: () => {} })
    const pending = execute({ id: 'invoke', name: 'mcp_manager', arguments: { action: 'invoke' } }, context)
    modeControl.change('plan', 'switch')
    broker.resolve('mcp-run', 'invoke', 'allow_once')
    await expect(pending).rejects.toThrow()
    expect(base).not.toHaveBeenCalled()
  })
})
