// server/tools/mcpManagerTool.ts
// Built-in tool for managing MCP servers on-demand

import { BUILTIN_TOOL_DEFINITIONS } from '../../../../shared/builtinToolDefinitions.js'
import Ajv from 'ajv'
import { mcpManager, McpServerConfig, McpToolDefinition } from '../mcp/mcpManager.js'
import { MCP_START_PHASE_MESSAGE, settleWithin, type McpStartPhase } from '../mcp/mcpStartPhase.js'
import { toMcpExecutionResult } from '../mcp/mcpToolResult.js'
import { attachChatErrorCode } from '../headlessServer/providers/providerErrorFormatter.js'

import { searchDiscovery, validateDiscoverySearch, type DiscoverySearchArgs } from './discoverySearch.js'

interface McpManagerArgs extends DiscoverySearchArgs {
  action: 'search' | 'list' | 'get' | 'stop' | 'list_tools' | 'invoke'
  name?: string
  tool?: string
  args?: Record<string, unknown>
}

interface McpServerSummary {
  name: string
  enabled: boolean
  autoStart?: boolean
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  /** Set while connecting: what the connection is waiting on. */
  phase?: McpStartPhase
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
  /** The server is still connecting, usually because it waits on the user; retry later. */
  pending?: boolean
  phase?: McpStartPhase
  invokedToolName?: string
  invokedVia?: 'mcp_manager'
  displayContent?: Record<string, unknown>
  persistedContent?: Record<string, unknown>
  servers?: McpServerSummary[]
  server?: McpServerSummary
  tools?: Array<ToolSummary & { serverName?: string }>
  totalCount?: number
  nextOffset?: number
}

const toServerSummary = (config: McpServerConfig, status?: ReturnType<typeof mcpManager.getServerStatus>): McpServerSummary => ({
  name: config.name,
  enabled: config.enabled,
  autoStart: config.autoStart,
  status: status?.status || 'disconnected',
  phase: status?.phase,
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
 * A connection that needs the user (keychain prompt, browser sign-in) can take minutes.
 * Report that to the model while the connection carries on, instead of running into the
 * tool-job timeout with nothing to say. Kept below the default 60 s job timeout.
 */
const START_WAIT_BUDGET_MS = 45_000

async function startOrReportPending(config: McpServerConfig, budgetMs: number): Promise<McpManagerResult | null> {
  const outcome = await settleWithin(mcpManager.startServer(config), budgetMs)
  if (outcome.settled) return null
  const phase = mcpManager.getStartPhase(config.name) ?? 'connecting'
  return {
    success: false,
    pending: true,
    phase,
    error: `MCP server "${config.name}" is not connected yet. ${MCP_START_PHASE_MESSAGE[phase]} ` +
      'Graviton keeps trying in the background. Tell the user what it is waiting for, then retry this action once they confirm.',
  }
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })

/**
 * Execute the mcp_manager tool
 */
export async function execute(
  args: McpManagerArgs,
  options: { operationMode?: 'plan' | 'execute'; signal?: AbortSignal; startWaitBudgetMs?: number } = {}
): Promise<McpManagerResult> {
  const { action, name } = args
  options.signal?.throwIfAborted()

  await mcpManager.initialize()

  if (action === 'list') {
    const configs = await mcpManager.getConfigs()
    const statusList = mcpManager.getStatus()
    const servers = configs.map(config => toServerSummary(config, statusList.find(s => s.name === config.name)))
    servers.sort((a, b) => a.name.localeCompare(b.name))
    return { success: true, servers, totalCount: servers.length }
  }

  if (action === 'search') {
    const error = validateDiscoverySearch(args)
    if (error) return { success: false, error }
    const configs = await mcpManager.getConfigs()
    if (name && !configs.some(config => config.name === name)) {
      return { success: false, error: `MCP server "${name}" not found` }
    }
    if (name && !configs.find(config => config.name === name)?.enabled) {
      return { success: false, error: `MCP server "${name}" is disabled` }
    }
    // Search only already-connected servers. Connecting here would fan out MCP
    // initialization (and interactive OAuth) to every configured server.
    const tools: Array<ToolSummary & { serverName: string }> = []
    for (const config of configs.filter(config => config.enabled && (!name || config.name === name))) {
      const status = mcpManager.getServerStatus(config.name)
      if (status?.status !== 'connected') continue
      for (const tool of status.tools ?? []) {
        const visibility = tool._meta?.ui?.visibility
        if (Array.isArray(visibility) && !visibility.includes('model')) continue
        tools.push({ ...toToolSummary(tool), serverName: config.name })
      }
    }
    const { items, ...page } = searchDiscovery(tools, args,
      tool => `${tool.serverName} ${tool.name} ${tool.description ?? ''}`)
    return { success: true, tools: items, ...page }
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
    const pending = await startOrReportPending(config, options.startWaitBudgetMs ?? START_WAIT_BUDGET_MS)
    if (pending) return pending
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
    const pending = await startOrReportPending(config, options.startWaitBudgetMs ?? START_WAIT_BUDGET_MS)
    if (pending) return pending
    const status = mcpManager.getServerStatus(name)
    const tools = status?.tools?.filter(tool => {
      const visibility = tool._meta?.ui?.visibility
      return !Array.isArray(visibility) || visibility.includes('model')
    }).map(toToolSummary) || []
    return { success: true, tools, totalCount: tools.length }
  }

  return { success: false, error: `Unknown action: ${action}` }
}

export const mcpManagerDefinition = BUILTIN_TOOL_DEFINITIONS.find(tool => tool.name === 'mcp_manager')!
