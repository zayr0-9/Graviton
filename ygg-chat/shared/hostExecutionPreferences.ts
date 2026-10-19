import { validateHostModePrompts, type HostModePrompts } from './hostModePrompts.js'
import { validateHostSubagentPreferences, type HostSubagentPreferences } from './hostSubagentPreferences.js'
import { validateHostProviderPreferences, type HostProviderPreferences } from './hostProviderPreferences.js'
import { normalizeContextDirectorySettings, type ContextDirectorySettings } from './contextDirectories.js'
export interface HostExecutionPreferences {
  provider: HostProviderPreferences
  tools: Record<string, boolean>
  subagent: HostSubagentPreferences
  modePrompts: HostModePrompts
  toolTimeouts: { toolCallTimeoutMs: number; bashTimeoutMs: number }
  toolAutoApprove: boolean
  autoCompactionEnabled: boolean
  longTermMemoryContextEnabled: boolean
  contextDirectories: ContextDirectorySettings
  planModeVerbosity: 'concise' | 'normal' | 'detailed'
}
export interface HostExecutionSnapshot {
  repairNeeded?: string
  hostId: string
  epoch: string
  revision: number
  revisions?: Partial<Record<keyof HostExecutionPreferences, number>>
  values: HostExecutionPreferences
}
export function normalizeHostExecutionPreferences(input: unknown): HostExecutionPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid execution preferences')
  const value = input as Record<string, unknown>
  const allowed = new Set(['toolAutoApprove', 'autoCompactionEnabled', 'longTermMemoryContextEnabled', 'contextDirectories', 'planModeVerbosity', 'provider', 'tools', 'subagent', 'modePrompts', 'toolTimeouts'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unknown execution preference')
  for (const key of ['toolAutoApprove', 'autoCompactionEnabled', 'longTermMemoryContextEnabled']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`Invalid ${key}`)
  }
  if (value.planModeVerbosity !== undefined && !['concise', 'normal', 'detailed'].includes(String(value.planModeVerbosity))) throw new Error('Invalid plan verbosity')
  const tools = value.tools ?? {}
  if (!tools || typeof tools !== 'object' || Array.isArray(tools) || Object.keys(tools).length > 2000 || Object.entries(tools).some(([key, enabled]) => !key || key.length > 200 || typeof enabled !== 'boolean')) throw new Error('Invalid tool defaults')
  const toolTimeouts = { toolCallTimeoutMs: 60000, bashTimeoutMs: 60000, ...(value.toolTimeouts as object ?? {}) }
  if (Object.keys(toolTimeouts).some(key => !['toolCallTimeoutMs', 'bashTimeoutMs'].includes(key)) ||
    !Number.isSafeInteger(toolTimeouts.toolCallTimeoutMs) || toolTimeouts.toolCallTimeoutMs < 1000 || toolTimeouts.toolCallTimeoutMs > 6000000 ||
    !Number.isSafeInteger(toolTimeouts.bashTimeoutMs) || toolTimeouts.bashTimeoutMs < 1000 || toolTimeouts.bashTimeoutMs > 600000) throw new Error('Invalid tool timeouts')
  return { toolTimeouts, modePrompts: validateHostModePrompts(value.modePrompts ?? {}), subagent: validateHostSubagentPreferences(value.subagent ?? {}), tools: { ...tools } as Record<string, boolean>, provider: validateHostProviderPreferences(value.provider ?? {}), autoCompactionEnabled: value.autoCompactionEnabled !== false, toolAutoApprove: value.toolAutoApprove === true, longTermMemoryContextEnabled: value.longTermMemoryContextEnabled !== false,
    contextDirectories: normalizeContextDirectorySettings(value.contextDirectories),
    planModeVerbosity: (value.planModeVerbosity ?? 'concise') as HostExecutionPreferences['planModeVerbosity'] }
}
