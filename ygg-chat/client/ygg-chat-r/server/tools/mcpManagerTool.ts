// server/tools/mcpManagerTool.ts
// Built-in tool for managing MCP servers on-demand

import { mcpManager, McpServerConfig, McpToolDefinition } from '../mcp/mcpManager.js'

interface McpManagerArgs {
  action: 'list' | 'get' | 'stop' | 'list_tools'
  name?: string
}

interface McpServerSummary {
  name: string
  enabled: boolean
  autoStart?: boolean
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  toolCount: number
  resourceCount: number
  promptCount: number
}

interface ToolSummary {
  name: string
  qualifiedName?: string
  description?: string
  inputSchema: McpToolDefinition['inputSchema']
  _meta?: McpToolDefinition['_meta']
}

interface McpManagerResult {
  success: boolean
  error?: string
  servers?: McpServerSummary[]
  server?: McpServerSummary
  tools?: ToolSummary[]
  totalCount?: number
}

const toServerSummary = (config: McpServerConfig, status?: ReturnType<typeof mcpManager.getServerStatus>): McpServerSummary => ({
  name: config.name,
  enabled: config.enabled,
  autoStart: config.autoStart,
  status: status?.status || 'disconnected',
  error: status?.error,
  toolCount: status?.tools?.length || 0,
  resourceCount: status?.resources?.length || 0,
  promptCount: status?.prompts?.length || 0,
})

const toToolSummary = (tool: McpToolDefinition): ToolSummary => ({
  name: tool.name,
  qualifiedName: tool.qualifiedName,
  description: tool.description,
  inputSchema: tool.inputSchema,
  _meta: tool._meta,
})

/**
 * Execute the mcp_manager tool
 */
export async function execute(args: McpManagerArgs): Promise<McpManagerResult> {
  const { action, name } = args

  await mcpManager.initialize()

  if (action === 'list') {
    const configs = await mcpManager.getConfigs()
    const statusList = mcpManager.getStatus()
    const servers = configs.map(config => toServerSummary(config, statusList.find(s => s.name === config.name)))
    servers.sort((a, b) => a.name.localeCompare(b.name))
    return { success: true, servers, totalCount: servers.length }
  }

  if (!name) {
    return { success: false, error: 'Missing "name" parameter for this action' }
  }

  const configs = await mcpManager.getConfigs()
  const config = configs.find(c => c.name === name)

  if (!config) {
    return { success: false, error: `MCP server "${name}" not found` }
  }

  if (action === 'get') {
    const status = mcpManager.getServerStatus(name)
    return { success: true, server: toServerSummary(config, status) }
  }

  if (action === 'stop') {
    await mcpManager.stopServer(name)
    const status = mcpManager.getServerStatus(name)
    return { success: true, server: toServerSummary(config, status) }
  }

  if (action === 'list_tools') {
    if (!config.enabled) {
      return { success: false, error: `MCP server "${name}" is disabled` }
    }
    await mcpManager.startServer(config)
    const status = mcpManager.getServerStatus(name)
    const tools = status?.tools?.map(toToolSummary) || []
    return { success: true, tools, totalCount: tools.length }
  }

  return { success: false, error: `Unknown action: ${action}` }
}

export const mcpManagerDefinition = {
  name: 'mcp_manager',
  description:
    'Discover MCP servers on demand. Use "list" to see configured servers, "get" for details, "stop" to stop a server, and "list_tools" to start a server if needed and retrieve its tools.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'stop', 'list_tools'],
        description: 'Action to perform',
      },
      name: {
        type: 'string',
        description: 'MCP server name (required for get/start/stop/restart/list_tools)',
      },
    },
    required: ['action'],
  },
}
