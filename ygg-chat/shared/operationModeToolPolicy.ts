export type OperationMode = 'plan' | 'execute'

export interface OperationModeToolPolicyDefinition {
  name: string
  isCustom?: boolean
  isMcp?: boolean
}

export const CHAT_MODE_ALLOWED_TOOL_NAMES = new Set([
  'bash',
  'browse_web',
  'brave_search',
  'fetch_chats',
  'context_status',
  'fetch_notes',
  'finance',
  'glob',
  'internalLink',
  'multi_call',
  'repl',
  'plan_md',
  'read_file',
  'read_file_continuation',
  'read_files',
  'ripgrep',
  'sports',
  'time',
  'view_image',
  'weather',
  'powershell',
  'subagent',
  'subagent_manager',
  'watcher',
  'custom_tool_manager',
  'mcp_manager',
  'skill_manager',
])

export const CHAT_MODE_BLOCKED_TOOL_NAMES = new Set([
  'create_file',
  'edit_file',
  'multi_edit',
  'delete_file',
])

/**
 * Tools a subagent may NOT run when the parent did not grant auto-approve.
 * This is a superset of the plan-mode block list: plan mode still permits
 * bash/powershell, but those can mutate the system, so an unattended subagent
 * without auto-approval must be held to genuinely read-only tools.
 */
export const AUTO_APPROVE_REQUIRED_TOOL_NAMES = new Set([
  ...CHAT_MODE_BLOCKED_TOOL_NAMES,
  'bash',
  'powershell',
  'html_renderer',
  'theme_manager',
  'custom_tool_manager',
  'mcp_manager',
  'skill_manager',
])

/**
 * Throws a structured "denied: requires auto-approve" error for tools that can
 * modify files or system state. The tool loop turns the throw into an is_error
 * tool_result the model can read and relay. Custom and MCP tools are always
 * gated because their side effects are unknown to this policy.
 */
function isReplExport(toolCall: any): boolean {
  if (toolCall?.name !== 'repl') return false
  try {
    const args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments
    return args?.howto !== true && args?.action === 'export'
  } catch { return false } // Invalid arguments are rejected by the executor.
}

export function assertToolAllowedWithoutAutoApprove(toolCall: any): void {
  const name = typeof toolCall?.name === 'string' ? toolCall.name : ''
  if (!name) return

  const isMcp = name.startsWith('mcp__') || toolCall?.isMcp === true
  const isCustom = toolCall?.isCustom === true

  if (AUTO_APPROVE_REQUIRED_TOOL_NAMES.has(name) || isMcp || isCustom || isReplExport(toolCall)) {
    throw new Error(
      JSON.stringify({
        denied: true,
        reason: 'requires auto-approve',
        tool: name,
        message: `denied: requires auto-approve — "${name}" can modify files or system state and the parent run did not grant auto-approval.`,
      })
    )
  }
}

export function filterToolsForOperationMode<T extends OperationModeToolPolicyDefinition>(
  tools: T[],
  _operationMode: OperationMode
): T[] {
  // Keep Agent-only schemas visible in Plan mode so the server can ask the user
  // to switch modes when the model needs one. Execution remains gated below.
  // MCP schemas are discovered and invoked through the stable mcp_manager tool.
  // Also strip legacy/client-supplied direct definitions at the server boundary.
  return tools.filter(tool => !tool.isMcp && !tool.name.startsWith('mcp__'))
}

function isMcpInvoke(toolCall: any): boolean {
  if (toolCall?.name !== 'mcp_manager') return false
  try {
    const args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments
    return args?.action === 'invoke'
  } catch { return false }
}

export function requiresAgentMode(toolCall: any, operationMode: OperationMode): boolean {
  if (operationMode !== 'plan') return false
  const toolName = typeof toolCall?.name === 'string' ? toolCall.name : ''
  // Custom and MCP definitions do not retain their registry flags on a provider
  // tool call. Anything outside the Plan-mode allow list therefore needs an
  // explicit Agent-mode upgrade before it can execute.
  return isMcpInvoke(toolCall) || isReplExport(toolCall) || (Boolean(toolName) && !CHAT_MODE_ALLOWED_TOOL_NAMES.has(toolName))
}

export function assertToolAllowedForOperationMode(toolCall: any, operationMode: OperationMode): void {
  if (operationMode !== 'plan') return

  const toolName = typeof toolCall?.name === 'string' ? toolCall.name : ''
  if (!toolName) return

  if (CHAT_MODE_BLOCKED_TOOL_NAMES.has(toolName) || toolName.startsWith('mcp__') || isMcpInvoke(toolCall) || isReplExport(toolCall)) {
    throw new Error(
      `Tool "${toolName}" is not available in Chat Mode. Switch to Agent Mode to run tools that can modify files, system state, or app state.`
    )
  }
}
