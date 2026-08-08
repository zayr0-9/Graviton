// electron/tools/customToolManager.ts
// Built-in tool for managing and querying custom tools
// Reduces context by allowing AI to discover tools on-demand instead of receiving all definitions upfront

import Ajv, { type ErrorObject } from 'ajv'
import { customToolRegistry, CustomToolDefinition, ToolExecutionOptions, ToolResult } from './customToolLoader'

interface CustomToolManagerArgs {
  action: 'list' | 'get' | 'invoke' | 'enable' | 'disable' | 'add' | 'remove' | 'reload' | 'settings'
  names?: string[] // For 'get' action - tool names to retrieve full definitions
  name?: string // For enable/disable/remove/invoke
  args?: Record<string, any> // For invoke
  sourcePath?: string // For add
  directoryName?: string // Optional destination directory for add
  overwrite?: boolean // For add
  autoRefresh?: boolean // For settings
  refreshDebounceMs?: number // For settings
}

interface ToolSummary {
  name: string
  description: string // Brief one-line description
  enabled: boolean
  loaded?: boolean
  directoryName?: string
}

interface CustomToolManagerResult {
  success: boolean
  error?: string
  invokedToolName?: string
  invokedVia?: 'custom_tool_manager'
  validationErrors?: Array<{
    instancePath: string
    keyword: string
    message: string
    params?: Record<string, any>
  }>
  expectedSchemaHint?: string
  retryInstruction?: string
  // For 'list' action
  tools?: ToolSummary[]
  totalCount?: number
  // For 'get' action
  definitions?: CustomToolDefinition[]
  notFound?: string[]
  // For lifecycle actions
  tool?: CustomToolDefinition
  settings?: {
    autoRefresh: boolean
    refreshDebounceMs: number
  }
  added?: {
    targetPath: string
    loadedToolNames: string[]
  }
  removed?: {
    removedPath: string
    removedToolNames: string[]
  }
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
})

/**
 * Truncate description to first sentence or first 100 chars
 */
function getBriefDescription(description: string): string {
  // First try to get first sentence
  const sentenceMatch = description.match(/^[^.!?]+[.!?]/)
  if (sentenceMatch && sentenceMatch[0].length <= 120) {
    return sentenceMatch[0].trim()
  }

  // Otherwise truncate at 100 chars
  if (description.length <= 100) {
    return description
  }

  return description.slice(0, 97) + '...'
}

function normalizeValidationErrors(errors: ErrorObject[] | null | undefined) {
  return (errors || []).map(error => ({
    instancePath: error.instancePath || '',
    keyword: error.keyword,
    message: error.message || 'Validation error',
    params: typeof error.params === 'object' && error.params ? (error.params as Record<string, any>) : undefined,
  }))
}

function describeSchemaField(name: string, schema: any): string {
  if (!schema || typeof schema !== 'object') return `${name}: any`

  const fieldType = Array.isArray(schema.type) ? schema.type.join('|') : schema.type
  const enumValues = Array.isArray(schema.enum) ? schema.enum.map((v: any) => JSON.stringify(v)).join(', ') : null

  if (enumValues) {
    const enumType = fieldType ? `${fieldType}, ` : ''
    return `${name}: ${enumType}enum(${enumValues})`
  }

  return `${name}: ${fieldType || 'any'}`
}

function buildExpectedSchemaHint(definition: CustomToolDefinition): string {
  const schema = definition.inputSchema
  const required = Array.isArray(schema?.required) ? schema.required : []
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const fieldHints = Object.entries(properties).map(([name, fieldSchema]) => describeSchemaField(name, fieldSchema))

  const requiredHint = required.length > 0 ? required.join(', ') : '(none)'
  const fieldsHint = fieldHints.length > 0 ? fieldHints.join('; ') : '(none)'
  return `Expected args for "${definition.name}" -> required: ${requiredHint}; fields: ${fieldsHint}.`
}

function stampHtmlToolName(result: ToolResult, toolName: string): ToolResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result
  }

  const normalized: ToolResult = { ...result }
  const hasToolName = (normalized as any).toolName !== undefined || (normalized as any).tool_name !== undefined

  if (!hasToolName && typeof (normalized as any).html === 'string') {
    ;(normalized as any).toolName = toolName
  } else if (
    !hasToolName &&
    (normalized as any).type === 'text/html' &&
    typeof (normalized as any).content === 'string'
  ) {
    ;(normalized as any).toolName = toolName
  }

  return normalized
}

function formatInvokeResult(result: ToolResult, toolName: string): CustomToolManagerResult {
  const stamped = stampHtmlToolName(result, toolName)
  if (stamped && typeof stamped === 'object' && !Array.isArray(stamped)) {
    return {
      ...(stamped as Record<string, any>),
      invokedToolName: toolName,
      invokedVia: 'custom_tool_manager',
    } as CustomToolManagerResult
  }

  return {
    success: true,
    invokedToolName: toolName,
    invokedVia: 'custom_tool_manager',
    value: stamped,
  } as CustomToolManagerResult
}

/**
 * Execute the custom_tool_manager tool
 */
export async function execute(args: CustomToolManagerArgs, options: ToolExecutionOptions = {}): Promise<CustomToolManagerResult> {
  const { action, names, name } = args

  // Ensure registry is initialized
  await customToolRegistry.initialize()

  if (action === 'list') {
    const statuses = customToolRegistry.getStatuses()

    const tools: ToolSummary[] = statuses.map(status => ({
      name: status.name,
      description: getBriefDescription(status.description),
      enabled: status.enabled,
      loaded: status.loaded,
      directoryName: status.directoryName,
    }))

    return {
      success: true,
      tools,
      totalCount: tools.length,
    }
  }

  if (action === 'get') {
    if (!names || !Array.isArray(names) || names.length === 0) {
      return {
        success: false,
        error: 'The "get" action requires a "names" array with at least one tool name',
      }
    }

    const allDefinitions = customToolRegistry.getDefinitions()
    const definitionMap = new Map(allDefinitions.map(d => [d.name, d]))

    const found: CustomToolDefinition[] = []
    const notFound: string[] = []

    for (const name of names) {
      const def = definitionMap.get(name)
      if (def) {
        found.push(def)
      } else {
        notFound.push(name)
      }
    }

    return {
      success: true,
      definitions: found,
      notFound: notFound.length > 0 ? notFound : undefined,
    }
  }

  if (action === 'invoke') {
    if (!name || typeof name !== 'string') {
      return { success: false, error: 'The "invoke" action requires a "name"' }
    }

    const allDefinitions = customToolRegistry.getDefinitions()
    const definition = allDefinitions.find(d => d.name === name)
    if (!definition) {
      console.warn(`[custom_tool_manager] invoke failed: tool not found (${name})`)
      return {
        success: false,
        error: `Custom tool "${name}" not found`,
        invokedToolName: name,
        invokedVia: 'custom_tool_manager',
      }
    }

    if (!definition.enabled) {
      console.warn(`[custom_tool_manager] invoke failed: tool disabled (${name})`)
      return {
        success: false,
        error: `Custom tool "${name}" is disabled`,
        invokedToolName: name,
        invokedVia: 'custom_tool_manager',
      }
    }

    const invokeArgsValue = args.args
    if (
      invokeArgsValue !== undefined &&
      (typeof invokeArgsValue !== 'object' || invokeArgsValue === null || Array.isArray(invokeArgsValue))
    ) {
      console.warn(`[custom_tool_manager] invoke validation failed: args must be object (${name})`)
      return {
        success: false,
        error: `Invalid arguments for custom tool "${name}"`,
        invokedToolName: name,
        invokedVia: 'custom_tool_manager',
        validationErrors: [
          {
            instancePath: '/args',
            keyword: 'type',
            message: 'args must be an object',
            params: { type: 'object' },
          },
        ],
        expectedSchemaHint: buildExpectedSchemaHint(definition),
        retryInstruction: 'Correct args and call custom_tool_manager with action "invoke" again.',
      }
    }

    const invokeArgs = (invokeArgsValue || {}) as Record<string, any>
    let validateFn: ReturnType<typeof ajv.compile>
    try {
      validateFn = ajv.compile(definition.inputSchema as any)
    } catch (error) {
      return {
        success: false,
        error: `Failed to validate schema for custom tool "${name}": ${error instanceof Error ? error.message : String(error)}`,
        invokedToolName: name,
        invokedVia: 'custom_tool_manager',
      }
    }

    const isValid = validateFn(invokeArgs)
    if (!isValid) {
      console.warn(`[custom_tool_manager] invoke validation failed for ${name}`)
      return {
        success: false,
        error: `Invalid arguments for custom tool "${name}"`,
        invokedToolName: name,
        invokedVia: 'custom_tool_manager',
        validationErrors: normalizeValidationErrors(validateFn.errors),
        expectedSchemaHint: buildExpectedSchemaHint(definition),
        retryInstruction: 'Correct args and call custom_tool_manager with action "invoke" again.',
      }
    }

    const result = await customToolRegistry.executeTool(name, invokeArgs, options)
    console.log(`[custom_tool_manager] invoke executed: ${name} (success=${result?.success !== false})`)
    return formatInvokeResult(result, name)
  }

  if (action === 'enable' || action === 'disable') {
    if (!name || typeof name !== 'string') {
      return { success: false, error: `The "${action}" action requires a "name"` }
    }

    const definition = await customToolRegistry.setToolEnabled(name, action === 'enable')
    if (!definition) {
      return { success: false, error: `Custom tool "${name}" not found` }
    }

    return {
      success: true,
      tool: definition,
    }
  }

  if (action === 'add') {
    if (!args.sourcePath || typeof args.sourcePath !== 'string') {
      return { success: false, error: 'The "add" action requires a "sourcePath" directory path' }
    }

    try {
      const result = await customToolRegistry.addToolFromDirectory(args.sourcePath, {
        directoryName: args.directoryName,
        overwrite: args.overwrite,
      })
      return {
        success: true,
        added: result,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  if (action === 'remove') {
    if (!name || typeof name !== 'string') {
      return { success: false, error: 'The "remove" action requires a "name"' }
    }

    try {
      const result = await customToolRegistry.removeTool(name)
      return {
        success: true,
        removed: result,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  if (action === 'reload') {
    await customToolRegistry.reload('manager_reload')
    const tools = customToolRegistry.getStatuses().map(status => ({
      name: status.name,
      description: getBriefDescription(status.description),
      enabled: status.enabled,
      loaded: status.loaded,
      directoryName: status.directoryName,
    }))
    return {
      success: true,
      tools,
      totalCount: tools.length,
    }
  }

  if (action === 'settings') {
    const hasUpdate = args.autoRefresh !== undefined || args.refreshDebounceMs !== undefined
    const settings = hasUpdate
      ? await customToolRegistry.updateSettings({
          autoRefresh: args.autoRefresh,
          refreshDebounceMs: args.refreshDebounceMs,
        })
      : customToolRegistry.getSettings()

    return {
      success: true,
      settings,
    }
  }

  return {
    success: false,
    error:
      'Unknown action. Valid actions: "list", "get", "invoke", "enable", "disable", "add", "remove", "reload", "settings".',
  }
}
