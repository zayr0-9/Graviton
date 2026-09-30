import type { OperationMode } from './chatTypes'
import sysPromptConfig from './sys_prompt.json'
import { getCombinedOperationModePrompt } from '../../helpers/operationModePromptStorage'
import {
  loadPlanModeResponseSettings,
  normalizePlanModeVerbosity,
  type PlanModeVerbosity,
} from '../../helpers/planModeResponseSettingsStorage'
export {
  CHAT_MODE_ALLOWED_TOOL_NAMES,
  CHAT_MODE_BLOCKED_TOOL_NAMES,
  assertToolAllowedForOperationMode,
  filterToolsForOperationMode,
} from '../../../../../shared/operationModeToolPolicy'

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
  planModeVerbosity?: PlanModeVerbosity | null
}

export function getOperationModeSystemPrompt(_operationMode: OperationMode): string {
  return getCombinedOperationModePrompt()
}

export function buildPlanModeResponseStylePrompt(verbosity?: PlanModeVerbosity | null): string {
  const resolvedVerbosity = normalizePlanModeVerbosity(verbosity ?? loadPlanModeResponseSettings().verbosity)

  switch (resolvedVerbosity) {
    case 'detailed':
      return '## Plan Response Style (only while Chat mode is active)\n\nUse detailed plans when helpful, but stay focused and avoid unrelated explanation.'
    case 'normal':
      return '## Plan Response Style (only while Chat mode is active)\n\nUse a balanced plan with enough detail to implement the change. Avoid unnecessary verbosity.'
    case 'concise':
    default:
      return '## Plan Response Style (only while Chat mode is active)\n\nUse short, concise plans. Prefer brief bullets and avoid unnecessary detail.'
  }
}

export function buildOperationModeSystemPrompt({
  operationMode,
  defaultUserPrompt,
  projectPrompt,
  conversationPrompt,
  basePrompt,
  includeCustomToolsPrompt = true,
  planModeVerbosity,
}: BuildOperationModeSystemPromptInput): string {
  const parts: string[] = []

  appendPromptPart(parts, getOperationModeSystemPrompt(operationMode))
  appendPromptPart(parts, buildPlanModeResponseStylePrompt(planModeVerbosity))
  appendPromptPart(parts, basePrompt)
  appendPromptPart(parts, defaultUserPrompt)
  appendPromptPart(parts, projectPrompt)
  appendPromptPart(parts, conversationPrompt)

  if (includeCustomToolsPrompt) {
    appendPromptPart(parts, sysPromptConfig.customToolsPrompt)
  }

  return parts.join('\n\n')
}

