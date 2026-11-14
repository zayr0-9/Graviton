import { beforeEach, describe, expect, it, vi } from 'vitest'

const { manager } = vi.hoisted(() => ({ manager: {
  initialize: vi.fn(), getConfigs: vi.fn(), getStatus: vi.fn(), getServerStatus: vi.fn(),
  startServer: vi.fn(), reauthenticateServer: vi.fn(), stopServer: vi.fn(), callServerTool: vi.fn(), getStartPhase: vi.fn(),
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

  it('exposes explicit reauthentication without invoking any MCP tool', async () => {
    expect(mcpManagerDefinition.inputSchema.properties?.action.enum).toContain('reauthenticate')
    const result = await execute({ action: 'reauthenticate', name: 'demo_server' })
    expect(result).toMatchObject({ success: true, server: { status: 'connected' } })
    expect(manager.reauthenticateServer).toHaveBeenCalledWith('demo_server')
    expect(manager.startServer).not.toHaveBeenCalled()
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })

  it('reports pending sign-in and tells agents to check status, not reset again', async () => {
    manager.reauthenticateServer.mockReturnValue(new Promise(() => {}))
    manager.getStartPhase.mockReturnValue('authorizing')
    const result = await execute({ action: 'reauthenticate', name: 'demo_server' }, { startWaitBudgetMs: 5 })
    expect(result).toMatchObject({ success: false, pending: true, phase: 'authorizing' })
    expect(result.error).toContain('Use get')
    expect(result.error).toContain('do not repeatedly reset')
  })

  it('returns reauthentication failures without claiming success', async () => {
    manager.reauthenticateServer.mockRejectedValue(new Error('Keychain denied'))
    expect(await execute({ action: 'reauthenticate', name: 'demo_server' })).toMatchObject({ success: false, error: 'Keychain denied' })
    manager.reauthenticateServer.mockClear()
    expect((await execute({ action: 'reauthenticate', name: 'missing' })).success).toBe(false)
    expect(manager.reauthenticateServer).not.toHaveBeenCalled()
  })

  it('lists servers without connecting, then returns tool schemas on demand', async () => {
    expect((await execute({ action: 'list' })).servers).toHaveLength(1)
    expect(manager.startServer).not.toHaveBeenCalled()
    const listed = await execute({ action: 'list_tools', name: 'demo_server' })
    expect(listed.tools?.[0].inputSchema).toEqual(definition.inputSchema)
    expect(manager.startServer).toHaveBeenCalledOnce()
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })

  it('searches across enabled servers and returns only matching model-visible schemas', async () => {
    manager.getConfigs.mockResolvedValue([{ name: 'demo_server', enabled: true }, { name: 'disabled', enabled: false }])
    manager.getServerStatus.mockReturnValue({ status: 'connected', tools: [
      { ...definition, description: 'Echo messages' },
      { ...definition, name: 'unrelated' },
      { ...definition, name: 'private_echo', _meta: { ui: { visibility: ['app'] } } },
    ] })
    const result = await execute({ action: 'search', query: 'DEMO echo', limit: 1 })
    expect(result).toMatchObject({ success: true, totalCount: 1, tools: [{ name: 'echo', serverName: 'demo_server', inputSchema: definition.inputSchema }] })
    expect(manager.startServer).not.toHaveBeenCalled()
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })

  it('rejects scoped searches on disabled or unknown servers', async () => {
    manager.getConfigs.mockResolvedValue([{ name: 'disabled', enabled: false }])
    expect(await execute({ action: 'search', query: 'echo', name: 'disabled' })).toMatchObject({ success: false, error: 'MCP server "disabled" is disabled' })
    expect(await execute({ action: 'search', query: 'echo', name: 'unknown' })).toMatchObject({ success: false, error: 'MCP server "unknown" not found' })
    expect(manager.startServer).not.toHaveBeenCalled()
  })

  it('validates the query and never connects servers during search', async () => {
    expect((await execute({ action: 'search', query: ' ' })).success).toBe(false)
    manager.getConfigs.mockResolvedValue([{ name: 'demo_server', enabled: true }, { name: 'signed_out', enabled: true }])
    manager.getServerStatus.mockImplementation((name: string) => name === 'demo_server'
      ? { status: 'connected', tools: [definition] }
      : { status: 'disconnected', tools: [{ ...definition, name: 'echo_stale' }] })
    const result = await execute({ action: 'search', query: 'echo' })
    expect(result).toMatchObject({ success: true, totalCount: 1, tools: [{ name: 'echo', serverName: 'demo_server' }] })
    expect(result).not.toHaveProperty('serverErrors')
    expect(manager.startServer).not.toHaveBeenCalled()
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

  it('allows invocation in Chat (plan) mode', async () => {
    const result = await execute({ action: 'invoke', name: 'demo_server', tool: 'echo', args: { text: 'hi' } }, { operationMode: 'plan' })
    expect(result.success).toBe(true)
    expect(manager.callServerTool).toHaveBeenCalledWith('demo_server', 'echo', { text: 'hi' })
  })

  it.each([
    ['list_tools', 'credentials', /keychain prompt/i],
    ['invoke', 'authorizing', /browser/i],
  ] as const)('reports a %s start that waits on the user instead of running into the job timeout', async (action, phase, hint) => {
    manager.startServer.mockReturnValue(new Promise(() => {}))
    manager.getStartPhase.mockReturnValue(phase)
    const result = await execute({ action, name: 'demo_server', tool: 'echo', args: { text: 'x' } }, { startWaitBudgetMs: 10 })
    expect(result).toMatchObject({ success: false, pending: true, phase })
    expect(result.error).toMatch(hint)
    expect(result.error).toMatch(/retry/i)
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })

  it('still surfaces a start that fails within the wait', async () => {
    manager.startServer.mockRejectedValue(new Error('HTTP 401 Unauthorized'))
    await expect(execute({ action: 'list_tools', name: 'demo_server' }, { startWaitBudgetMs: 1000 })).rejects.toThrow('401')
  })

  it('shows what a connecting server is waiting on in get/list', async () => {
    manager.getServerStatus.mockReturnValue({ status: 'connecting', phase: 'authorizing', tools: [] })
    expect(await execute({ action: 'get', name: 'demo_server' })).toMatchObject({ server: { status: 'connecting', phase: 'authorizing' } })
  })

  it('blocks cancellation before connection/invocation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(execute({ action: 'invoke', name: 'demo_server', tool: 'echo' }, { signal: controller.signal })).rejects.toThrow()
    expect(manager.startServer).not.toHaveBeenCalled()
    expect(manager.callServerTool).not.toHaveBeenCalled()
  })
})
