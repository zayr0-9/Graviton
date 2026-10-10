// server/tools/mcpManagerTool.ts
// Built-in tool for managing MCP servers on-demand

import Ajv from 'ajv'
import { mcpManager, McpServerConfig, McpToolDefinition } from '../mcp/mcpManager.js'
import { toMcpExecutionResult } from '../mcp/mcpToolResult.js'
import { attachChatErrorCode } from '../headlessServer/providers/providerErrorFormatter.js'

interface McpManagerArgs {
  action: 'list' | 'get' | 'stop' | 'list_tools' | 'invoke'
  name?: string
  tool?: string
  args?: Record<string, unknown>
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
  invokedToolName?: string
  invokedVia?: 'mcp_manager'
  displayContent?: Record<string, unknown>
  persistedContent?: Record<string, unknown>
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

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })

/**
 * Execute the mcp_manager tool
 */
export async function execute(
  args: McpManagerArgs,
  options: { operationMode?: 'plan' | 'execute'; signal?: AbortSignal } = {}
): Promise<McpManagerResult> {
  const { action, name } = args
  options.signal?.throwIfAborted()
  if (action === 'invoke' && options.operationMode === 'plan') {
    throw new Error('MCP tool invocation requires Agent Mode. Switch to Agent Mode to invoke MCP tools.')
  }

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

  if (action === 'invoke') {
    if (!config.enabled) return { success: false, error: `MCP server "${name}" is disabled` }
    if (!args.tool || typeof args.tool !== 'string') {
      return { success: false, error: 'The "invoke" action requires a "tool" name from list_tools' }
    }
    if (args.args !== undefined && (!args.args || typeof args.args !== 'object' || Array.isArray(args.args))) {
      return { success: false, error: 'The "invoke" action requires "args" to be an object' }
    }
    await mcpManager.startServer(config)
    options.signal?.throwIfAborted()
    const definition = mcpManager.getServerStatus(name)?.tools.find(tool => tool.name === args.tool)
    const visibility = definition?._meta?.ui?.visibility
    if (!definition || (Array.isArray(visibility) && !visibility.includes('model'))) {
      return { success: false, error: `MCP tool "${args.tool}" not found or not model-visible on server "${name}"` }
    }
    const invokeArgs = args.args ?? {}
    try {
      const validate = ajv.compile(definition.inputSchema)
      if (!validate(invokeArgs)) {
        return {
          success: false,
          error: `Invalid arguments for MCP tool "${args.tool}": ${ajv.errorsText(validate.errors)}`,
        }
      }
    } catch (error) {
      return { success: false, error: `Failed to validate MCP tool schema: ${error instanceof Error ? error.message : String(error)}` }
    }
    options.signal?.throwIfAborted()
    try {
      const result = await mcpManager.callServerTool(name, definition.name, invokeArgs)
      // UI metadata stays in the host/persisted channel, not the model continuation.
      const hostResult = {
        ...result,
        invokedVia: 'mcp_manager',
        invokedToolName: definition.qualifiedName,
        mcpToolDefinition: { ...definition, serverName: name },
      }
      return {
        ...toMcpExecutionResult(result),
        displayContent: hostResult,
        persistedContent: hostResult,
        success: !result.isError,
        invokedToolName: definition.qualifiedName ?? `mcp__${name}__${definition.name}`,
        invokedVia: 'mcp_manager',
      }
    } catch (error) {
      throw attachChatErrorCode(error instanceof Error ? error : new Error(String(error)), 'mcp_unavailable')
    }
  }

  if (action === 'list_tools') {
    if (!config.enabled) {
      return { success: false, error: `MCP server "${name}" is disabled` }
    }
    await mcpManager.startServer(config)
    const status = mcpManager.getServerStatus(name)
    const tools = status?.tools?.filter(tool => {
      const visibility = tool._meta?.ui?.visibility
      return !Array.isArray(visibility) || visibility.includes('model')
    }).map(toToolSummary) || []
    return { success: true, tools, totalCount: tools.length }
  }

  return { success: false, error: `Unknown action: ${action}` }
}

export const mcpManagerDefinition = {
  name: 'mcp_manager',
  description:
    'Discover and invoke MCP tools on demand without changing model tool definitions. Use "list" for servers, "get" for status, "list_tools" for tool names and schemas, "invoke" with name (server), tool and args to execute, and "stop" to disconnect.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'stop', 'list_tools', 'invoke'],
        description: 'Action to perform',
      },
      name: {
        type: 'string',
        description: 'MCP server name (required for get, stop, list_tools and invoke)',
      },
      tool: {
        type: 'string',
        description: 'For invoke: original tool name returned by list_tools.',
      },
      args: {
        type: 'object',
        description: 'For invoke: arguments matching the tool inputSchema returned by list_tools.',
      },
    },
    required: ['action'],
  },
}
