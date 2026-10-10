import { beforeEach, describe, expect, it, vi } from 'vitest'

const { manager } = vi.hoisted(() => ({ manager: {
  initialize: vi.fn(), getConfigs: vi.fn(), getStatus: vi.fn(), getServerStatus: vi.fn(),
  startServer: vi.fn(), stopServer: vi.fn(), callServerTool: vi.fn(),
} }))
vi.mock('../../mcp/mcpManager.js', () => ({ mcpManager: manager }))

import { execute, mcpManagerDefinition } from '../mcpManagerTool.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions.js'

const definition = {
  name: 'echo', qualifiedName: 'mcp__demo_server__echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

describe('mcp_manager discovery and invoke', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    manager.getConfigs.mockResolvedValue([{ name: 'demo_server', enabled: true }])
    manager.getStatus.mockReturnValue([])
    manager.getServerStatus.mockReturnValue({ status: 'connected', tools: [definition] })
    manager.callServerTool.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }], _meta: { private: true } })
  })

  it('keeps the shared and server manager schemas aligned', () => {
    const shared = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'mcp_manager')!
    expect(shared.inputSchema).toEqual(mcpManagerDefinition.inputSchema)
    expect(shared.description).toEqual(mcpManagerDefinition.description)
  })

  it('lists servers without connecting, then returns tool schemas on demand', async () => {
    expect((await execute({ action: 'list' })).servers).toHaveLength(1)
    expect(manager.startServer).not.toHaveBeenCalled()
    const listed = await execute({ action: 'list_tools', name: 'demo_server' })
    expect(listed.tools?.[0].inputSchema).toEqual(definition.inputSchema)
    expect(manager.startServer).toHaveBeenCalledOnce()
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })

  it('invokes by server and original tool name, including underscores in server names', async () => {
    const result = await execute({ action: 'invoke', name: 'demo_server', tool: 'echo', args: { text: 'hello' } })
    expect(manager.callServerTool).toHaveBeenCalledWith('demo_server', 'echo', { text: 'hello' })
    expect(result).toMatchObject({ success: true, invokedVia: 'mcp_manager', invokedToolName: definition.qualifiedName,
      modelContent: [{ type: 'text', text: 'hello' }], displayContent: { _meta: { private: true } } })
    expect((result as any).modelContent).not.toEqual(expect.objectContaining({ _meta: expect.anything() }))
  })

  it.each([
    { tool: undefined, args: {} }, { tool: 'missing', args: {} },
    { tool: 'echo', args: {} }, { tool: 'echo', args: { text: 1 } },
    { tool: 'echo', args: [] }, { tool: 'echo', args: null },
  ])('rejects missing/invalid targets or arguments: %j', async ({ tool, args }) => {
    expect((await execute({ action: 'invoke', name: 'demo_server', tool, args } as any)).success).toBe(false)
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })

  it('rejects disabled servers and app-only tools', async () => {
    manager.getConfigs.mockResolvedValue([{ name: 'demo_server', enabled: false }])
    expect((await execute({ action: 'invoke', name: 'demo_server', tool: 'echo' })).error).toContain('disabled')
    expect(manager.startServer).not.toHaveBeenCalled()
    manager.getConfigs.mockResolvedValue([{ name: 'demo_server', enabled: true }])
    manager.getServerStatus.mockReturnValue({ tools: [{ ...definition, _meta: { ui: { visibility: ['app'] } } }] })
    expect((await execute({ action: 'invoke', name: 'demo_server', tool: 'echo' })).success).toBe(false)
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })

  it('preserves tool-level errors and transport error classification', async () => {
    manager.callServerTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'denied' }] })
    expect(await execute({ action: 'invoke', name: 'demo_server', tool: 'echo', args: { text: 'x' } })).toMatchObject({ success: false, error: 'denied' })
    manager.callServerTool.mockRejectedValue(new Error('connection closed'))
    await expect(execute({ action: 'invoke', name: 'demo_server', tool: 'echo', args: { text: 'x' } })).rejects.toMatchObject({ [Symbol.for('ygg.chat.errorCode')]: 'mcp_unavailable' })
  })

  it('blocks Plan mode and cancellation before connection/invocation', async () => {
    await expect(execute({ action: 'invoke', name: 'demo_server', tool: 'echo' }, { operationMode: 'plan' })).rejects.toThrow('Agent Mode')
    const controller = new AbortController()
    controller.abort()
    await expect(execute({ action: 'invoke', name: 'demo_server', tool: 'echo' }, { signal: controller.signal })).rejects.toThrow()
    expect(manager.startServer).not.toHaveBeenCalled()
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })
})
