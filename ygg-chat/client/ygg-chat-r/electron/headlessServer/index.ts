import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { mcpManager } from '../mcp/mcpManager.js'
import { customToolRegistry } from '../tools/customToolLoader.js'
import { toolOrchestrator } from '../tools/orchestrator/index.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../shared/builtinToolDefinitions.js'
import { syncOpenAiChatGptTokenFromElectronStorage, syncOpenRouterTokenFromElectronSession } from './providers/electronAppAuth.js'
import { ProviderTokenStore } from './providers/tokenStore.js'
import { registerCapabilityRoutes } from './routes/capabilityRoutes.js'
import { registerChatRoutes } from './routes/chatRoutes.js'
import { registerCrudRoutes } from './routes/crudRoutes.js'
import { registerProviderAuthRoutes } from './routes/providerAuthRoutes.js'
import { registerMobileUiRoutes } from './routes/mobileUiRoutes.js'
import { registerCustomToolsRoutes } from './routes/customToolsRoutes.js'
import { registerCustomToolRpcRoutes } from './routes/customToolRpcRoutes.js'
import { registerEphemeralGenerateRoutes } from './routes/ephemeralGenerateRoutes.js'
import { registerSubagentRoutes } from './routes/subagentRoutes.js'
import { registerTestHarnessRoutes } from './routes/testHarnessRoutes.js'
import { ChatOrchestrator } from './services/chatOrchestrator.js'
import { SubagentOrchestrator } from './services/subagentOrchestrator.js'
import type { ToolExecutor } from './services/toolLoopService.js'

interface HeadlessServerRouteDeps {
  db: Database.Database
  statements: any
}

type InferenceToolDefinition = { name: string; description?: string; inputSchema?: Record<string, any> }

const HEADLESS_RUNTIME_BUILTIN_TOOL_NAMES = new Set([
  'todo_list',
  'fetch_notes',
  'fetch_chats',
  'read_file',
  'read_file_continuation',
  'read_files',
  'create_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'directory',
  'glob',
  'ripgrep',
  'brave_search',
  'browse_web',
  'bash',
  'html_renderer',
  'theme_manager',
  'custom_tool_manager',
  'mcp_manager',
  'skill_manager',
])

const BUILT_IN_INFERENCE_TOOLS: InferenceToolDefinition[] = BUILTIN_TOOL_DEFINITIONS.filter(tool =>
  HEADLESS_RUNTIME_BUILTIN_TOOL_NAMES.has(tool.name)
).map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}))

const toMcpInferenceTool = (tool: any): InferenceToolDefinition | null => {
  const visibility = tool?._meta?.ui?.visibility
  if (Array.isArray(visibility) && !visibility.includes('model')) {
    return null
  }

  const name = typeof tool?.qualifiedName === 'string' ? tool.qualifiedName : typeof tool?.name === 'string' ? tool.name : null
  if (!name) return null

  return {
    name,
    description: typeof tool?.description === 'string' ? tool.description : undefined,
    inputSchema:
      tool?.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
  }
}

const dedupeToolsByName = (tools: InferenceToolDefinition[]): InferenceToolDefinition[] => {
  const byName = new Map<string, InferenceToolDefinition>()
  for (const tool of tools) {
    if (!tool?.name) continue
    if (!byName.has(tool.name)) {
      byName.set(tool.name, tool)
    }
  }
  return Array.from(byName.values())
}

const resolveDefaultInferenceTools = (): InferenceToolDefinition[] => {
  const tools: InferenceToolDefinition[] = [...BUILT_IN_INFERENCE_TOOLS]

  try {
    const customTools = customToolRegistry
      .getDefinitions()
      .filter(def => def.enabled)
      .map(def => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      }))
    tools.push(...customTools)
  } catch {
    // Ignore custom tool discovery failures in request-path fallback.
  }

  try {
    const mcpTools = mcpManager.getAllTools().map(toMcpInferenceTool).filter((tool): tool is InferenceToolDefinition => !!tool)
    tools.push(...mcpTools)
  } catch {
    // Ignore MCP discovery failures in request-path fallback.
  }

  return dedupeToolsByName(tools)
}

function bootstrapHeadlessProviderTokens(tokenStore: ProviderTokenStore): void {
  syncOpenRouterTokenFromElectronSession(tokenStore)
  syncOpenAiChatGptTokenFromElectronStorage(tokenStore)
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

const executeToolViaOrchestrator: ToolExecutor = async (toolCall, context) => {
  const timeoutMs = Math.max(1_000, Math.min(context.timeoutMs ?? 300_000, 600_000))

  const parsedArguments =
    typeof toolCall.arguments === 'string'
      ? (() => {
          try {
            return JSON.parse(toolCall.arguments)
          } catch {
            return {}
          }
        })()
      : toolCall.arguments ?? {}

  const job = toolOrchestrator.submit(toolCall.name, parsedArguments, {
    timeoutMs,
    rootPath: context.rootPath ?? null,
    operationMode: context.operationMode ?? 'execute',
    conversationId: context.conversationId ?? null,
    messageId: context.messageId ?? null,
    streamId: context.streamId ?? null,
  })

  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const current = toolOrchestrator.getJob(job.id)
    if (!current) {
      throw new Error(`Tool job disappeared: ${job.id}`)
    }

    if (current.status === 'completed') {
      return current.result
    }

    if (current.status === 'failed') {
      throw new Error(current.error || `Tool execution failed: ${toolCall.name}`)
    }

    if (current.status === 'cancelled') {
      throw new Error(`Tool execution cancelled: ${toolCall.name}`)
    }

    await sleep(100)
  }

  toolOrchestrator.cancel(job.id)
  throw new Error(`Tool execution timed out after ${timeoutMs}ms: ${toolCall.name}`)
}

export function registerHeadlessServerRoutes(app: Express, deps: HeadlessServerRouteDeps): void {
  const tokenStore = new ProviderTokenStore(deps.db)
  bootstrapHeadlessProviderTokens(tokenStore)

  registerCrudRoutes(app, deps)
  registerProviderAuthRoutes(app, { tokenStore })
  registerMobileUiRoutes(app)
  registerCustomToolsRoutes(app)
  registerCustomToolRpcRoutes(app)
  registerCapabilityRoutes(app, { getDefaultTools: resolveDefaultInferenceTools })
  registerEphemeralGenerateRoutes(app, { tokenStore })
  registerSubagentRoutes(app, {
    orchestrator: new SubagentOrchestrator({
      ...deps,
      tokenStore,
      toolExecutor: executeToolViaOrchestrator,
    }),
  })
  registerTestHarnessRoutes(app, {
    getDefaultTools: resolveDefaultInferenceTools,
  })
  registerChatRoutes(app, {
    orchestrator: new ChatOrchestrator({
      ...deps,
      tokenStore,
      toolExecutor: executeToolViaOrchestrator,
      defaultToolsProvider: resolveDefaultInferenceTools,
    }),
  })
}
