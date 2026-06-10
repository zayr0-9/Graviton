// src/features/chats/toolDefinitions.ts
// Tool definitions sent from client to server with each message request
// Tools execute locally via electron/localServer.ts, definitions are sent to AI API
// Supports both built-in tools and user-defined custom tools

import { loadToolEnabledStates } from '../../helpers/toolSettingsStorage'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions'

export interface ToolDefinition {
  name: string
  enabled: boolean
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
  // Custom tool metadata (set for user-defined tools)
  isCustom?: boolean
  sourcePath?: string
  version?: string
  author?: string
  // MCP tool metadata (set for MCP server tools)
  isMcp?: boolean
  mcpServerName?: string
  mcpToolName?: string // Original tool name before namespacing
  mcpUi?: {
    resourceUri?: string
    visibility?: Array<'model' | 'app'>
  }
  // Custom app permissions (used by iframe bridge for custom tool UIs)
  appPermissions?: {
    agent?: 'read' | 'write'
  }
  ui?: {
    entry?: string
  }
}

// Built-in tool definitions (static, shared source of truth)
const builtInToolDefinitions: ToolDefinition[] = BUILTIN_TOOL_DEFINITIONS.map(tool => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: { ...tool.inputSchema.properties },
    required: tool.inputSchema.required ? [...tool.inputSchema.required] : undefined,
  },
}))

// Helper to deep clone a tool definition (makes it mutable)
const cloneTool = (tool: ToolDefinition): ToolDefinition => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: { ...tool.inputSchema.properties },
    required: tool.inputSchema.required ? [...tool.inputSchema.required] : undefined,
  },
  mcpUi: tool.mcpUi
    ? { ...tool.mcpUi, visibility: tool.mcpUi.visibility ? [...tool.mcpUi.visibility] : undefined }
    : undefined,
  appPermissions: tool.appPermissions ? { ...tool.appPermissions } : undefined,
  ui: tool.ui ? { ...tool.ui } : undefined,
})

// Mutable array that holds merged tools (built-in + custom)
// Deep clone to ensure objects are mutable
// Apply persisted enabled states from localStorage on initialization
const initializeTools = (): ToolDefinition[] => {
  const tools = builtInToolDefinitions.map(cloneTool)
  const persistedStates = loadToolEnabledStates()
  for (const tool of tools) {
    if (persistedStates[tool.name] !== undefined) {
      tool.enabled = persistedStates[tool.name]
    }
  }
  return tools
}
let mergedToolDefinitions: ToolDefinition[] = initializeTools()

/**
 * Set custom tools from the local server.
 * Custom tools are merged with built-in tools.
 * Custom tools cannot override built-in tools with the same name.
 * Preserves user's enabled/disabled state from localStorage (persisted) and in-memory state.
 */
export const setCustomTools = (customTools: ToolDefinition[]): void => {
  // Load persisted states from localStorage (survives app restarts)
  const persistedStates = loadToolEnabledStates()

  // Also preserve current in-memory enabled state (for session changes)
  const currentEnabledState = new Map<string, boolean>()
  for (const tool of mergedToolDefinitions) {
    currentEnabledState.set(tool.name, tool.enabled)
  }

  // Filter out any custom tools that would override built-ins
  const builtInNames = new Set(builtInToolDefinitions.map(t => t.name))
  const safeCustomTools = customTools.filter(ct => {
    if (builtInNames.has(ct.name)) {
      console.warn(`[ToolDefinitions] Custom tool "${ct.name}" ignored: conflicts with built-in tool`)
      return false
    }
    return true
  })

  // Merge built-in (cloned) and custom tools (cloned for safety)
  mergedToolDefinitions = [...builtInToolDefinitions.map(cloneTool), ...safeCustomTools.map(cloneTool)]

  // Apply enabled state: localStorage takes priority, then in-memory state, then default
  for (const tool of mergedToolDefinitions) {
    if (persistedStates[tool.name] !== undefined) {
      // Use persisted state from localStorage (survives restarts)
      tool.enabled = persistedStates[tool.name]
    } else if (currentEnabledState.has(tool.name)) {
      // Fall back to in-memory state (session changes)
      tool.enabled = currentEnabledState.get(tool.name)!
    }
    // Otherwise keep the default from definition
  }
}

/**
 * Set MCP tools from connected MCP servers.
 * MCP tools are merged with built-in and custom tools.
 * MCP tools cannot override built-in or custom tools with the same name.
 * Preserves user's enabled/disabled state from localStorage and in-memory state.
 */
export const setMcpTools = (mcpTools: ToolDefinition[]): void => {
  // Load persisted states from localStorage
  const persistedStates = loadToolEnabledStates()

  // Preserve current in-memory enabled state
  const currentEnabledState = new Map<string, boolean>()
  for (const tool of mergedToolDefinitions) {
    currentEnabledState.set(tool.name, tool.enabled)
  }

  // Get existing non-MCP tools
  const nonMcpTools = mergedToolDefinitions.filter(t => !t.isMcp)

  // Filter out any MCP tools that would override existing tools
  const existingNames = new Set(nonMcpTools.map(t => t.name))
  const safeMcpTools = mcpTools.filter(mt => {
    if (existingNames.has(mt.name)) {
      console.warn(`[ToolDefinitions] MCP tool "${mt.name}" ignored: conflicts with existing tool`)
      return false
    }
    return true
  })

  // Mark all MCP tools
  const markedMcpTools = safeMcpTools.map(t => ({
    ...cloneTool(t),
    isMcp: true,
  }))

  // Merge: non-MCP tools + MCP tools
  mergedToolDefinitions = [...nonMcpTools, ...markedMcpTools]

  // Apply enabled state
  for (const tool of mergedToolDefinitions) {
    if (persistedStates[tool.name] !== undefined) {
      tool.enabled = persistedStates[tool.name]
    } else if (currentEnabledState.has(tool.name)) {
      tool.enabled = currentEnabledState.get(tool.name)!
    }
  }
}

/**
 * Clear all MCP tools (keep built-in and custom tools)
 * Preserves user's enabled/disabled state.
 */
export const clearMcpTools = (): void => {
  const persistedStates = loadToolEnabledStates()
  const currentEnabledState = new Map<string, boolean>()
  for (const tool of mergedToolDefinitions) {
    currentEnabledState.set(tool.name, tool.enabled)
  }

  mergedToolDefinitions = mergedToolDefinitions.filter(t => !t.isMcp)

  for (const tool of mergedToolDefinitions) {
    if (persistedStates[tool.name] !== undefined) {
      tool.enabled = persistedStates[tool.name]
    } else if (currentEnabledState.has(tool.name)) {
      tool.enabled = currentEnabledState.get(tool.name)!
    }
  }
}

/**
 * Get MCP tools only
 */
export const getMcpTools = (): ToolDefinition[] => {
  return mergedToolDefinitions.filter(t => t.isMcp)
}

/**
 * Clear all custom tools (reset to built-in only)
 * Preserves user's enabled/disabled state from localStorage and in-memory state.
 */
export const clearCustomTools = (): void => {
  // Load persisted states from localStorage
  const persistedStates = loadToolEnabledStates()

  // Also preserve current in-memory enabled state
  const currentEnabledState = new Map<string, boolean>()
  for (const tool of mergedToolDefinitions) {
    currentEnabledState.set(tool.name, tool.enabled)
  }

  mergedToolDefinitions = builtInToolDefinitions.map(cloneTool)

  // Apply enabled state: localStorage takes priority, then in-memory state
  for (const tool of mergedToolDefinitions) {
    if (persistedStates[tool.name] !== undefined) {
      tool.enabled = persistedStates[tool.name]
    } else if (currentEnabledState.has(tool.name)) {
      tool.enabled = currentEnabledState.get(tool.name)!
    }
  }
}

// Get all tool definitions (built-in + custom)
export const getAllTools = (): ToolDefinition[] => {
  return mergedToolDefinitions
}

// Get only enabled tools (built-in + custom)
export const getEnabledTools = (): ToolDefinition[] => {
  const enabled = mergedToolDefinitions.filter(t => t.enabled)
  const customCount = enabled.filter(t => t.isCustom).length
  if (customCount > 0) {
    enabled.filter(t => t.isCustom).map(t => t.name)
  }
  return enabled
}

// Get built-in tools only
export const getBuiltInTools = (): ToolDefinition[] => {
  return builtInToolDefinitions
}

// Get custom tools only
export const getCustomTools = (): ToolDefinition[] => {
  return mergedToolDefinitions.filter(t => t.isCustom)
}

/**
 * Get tools to send to AI API.
 * Returns enabled built-in tools and MCP tools (excludes custom tools).
 * Custom tools are accessed via the custom_tool_manager tool.
 * MCP tools are sent directly since they're already namespaced (mcp__serverName__toolName).
 */
export const getToolsForAI = (): ToolDefinition[] => {
  // Use mergedToolDefinitions (mutable) to get current enabled state
  // Include built-in and MCP tools, exclude custom tools (accessed via custom_tool_manager)
  const enabled = mergedToolDefinitions.filter(t => t.enabled && !t.isCustom)
  return enabled.filter(t => {
    if (!t.isMcp) return true
    const visibility = t.mcpUi?.visibility
    if (!Array.isArray(visibility)) return true
    return visibility.includes('model')
  })
}

// OpenAI ChatGPT tool calls are executed locally in Electron.
// Only expose built-in tools that have a local executor (or are handled specially in chatActions).
// This prevents server-only tools like search_history from being advertised on the OpenAI route.
const OPENAI_LOCALLY_SUPPORTED_BUILTIN_TOOL_NAMES = new Set<string>([
  'todo_list',
  'plan_md',
  'theme_manager',
  'fetch_notes',
  'fetch_chats',
  'internalLink',
  'read_file',
  'read_files',
  'read_file_continuation',
  'create_file',
  'delete_file',
  'view_image',
  'edit_file',
  'multi_edit',
  'brave_search',
  'ripgrep',
  'bash',
  'powershell',
  'html_renderer',
  'glob',
  'browse_web',
  'custom_tool_manager',
  'mcp_manager',
  'skill_manager',
  'subagent',
])

export const getToolsForOpenAIChatGPT = (): ToolDefinition[] => {
  return getToolsForAI().filter(tool => tool.isMcp || OPENAI_LOCALLY_SUPPORTED_BUILTIN_TOOL_NAMES.has(tool.name))
}

// Get tool by name
export const getToolByName = (name: string): ToolDefinition | undefined => {
  return mergedToolDefinitions.find(t => t.name === name)
}

// Update tool enabled status (works for both built-in and custom tools)
// Only updates mergedToolDefinitions (the mutable working copy)
export const updateToolEnabled = (name: string, enabled: boolean): boolean => {
  const tool = mergedToolDefinitions.find(t => t.name === name)
  if (tool) {
    tool.enabled = enabled
    return true
  }
  return false
}

export default builtInToolDefinitions
