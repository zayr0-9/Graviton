import type { OperationMode } from './chatTypes'
import sysPromptConfig from './sys_prompt.json'
import { getActiveChatModePrompt, getAgentModePrompt } from '../../helpers/operationModePromptStorage'
import type { ToolDefinition } from './toolDefinitions'

const appendPromptPart = (parts: string[], value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed) parts.push(trimmed)
}

export interface BuildOperationModeSystemPromptInput {
  operationMode: OperationMode
  defaultUserPrompt?: string | null
  projectPrompt?: string | null
  conversationPrompt?: string | null
  basePrompt?: string | null
  includeCustomToolsPrompt?: boolean
}

export function getOperationModeSystemPrompt(operationMode: OperationMode): string {
  return operationMode === 'plan' ? getActiveChatModePrompt().prompt : getAgentModePrompt().prompt
}

export function buildOperationModeSystemPrompt({
  operationMode,
  defaultUserPrompt,
  projectPrompt,
  conversationPrompt,
  basePrompt,
  includeCustomToolsPrompt = true,
}: BuildOperationModeSystemPromptInput): string {
  const parts: string[] = []

  appendPromptPart(parts, getOperationModeSystemPrompt(operationMode))
  appendPromptPart(parts, basePrompt)
  appendPromptPart(parts, defaultUserPrompt)
  appendPromptPart(parts, projectPrompt)
  appendPromptPart(parts, conversationPrompt)

  if (includeCustomToolsPrompt) {
    appendPromptPart(parts, sysPromptConfig.customToolsPrompt)
  }

  return parts.join('\n\n')
}

const CHAT_MODE_ALLOWED_TOOL_NAMES = new Set([
  'browse_web',
  'brave_search',
  'fetch_chats',
  'fetch_notes',
  'finance',
  'glob',
  'internalLink',
  'read_file',
  'read_file_continuation',
  'read_files',
  'ripgrep',
  'sports',
  'time',
  'view_image',
  'weather',
])

const CHAT_MODE_BLOCKED_TOOL_NAMES = new Set([
  'bash',
  'powershell',
  'create_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'subagent',
  'custom_tool_manager',
  'theme_manager',
  'todo_list',
  'mcp_manager',
  'skill_manager',
  'html_renderer',
])

export function filterToolsForOperationMode<T extends ToolDefinition>(tools: T[], operationMode: OperationMode): T[] {
  if (operationMode !== 'plan') return tools
  return tools.filter(tool => !tool.isCustom && !tool.isMcp && CHAT_MODE_ALLOWED_TOOL_NAMES.has(tool.name))
}

export function assertToolAllowedForOperationMode(toolCall: any, operationMode: OperationMode): void {
  if (operationMode !== 'plan') return

  const toolName = typeof toolCall?.name === 'string' ? toolCall.name : ''
  if (!toolName) return

  if (CHAT_MODE_BLOCKED_TOOL_NAMES.has(toolName) || toolName.startsWith('mcp__')) {
    throw new Error(
      `Tool "${toolName}" is not available in Chat Mode. Switch to Agent Mode to run tools that can modify files, system state, app state, or spawn agents.`
    )
  }
}
