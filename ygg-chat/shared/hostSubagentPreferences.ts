export interface HostSubagentPreferences {
  enabledTools: string[]
  orchestratorEnabled: boolean
  defaultProvider: string | null
  defaultModel: string | null
  maxTurns: number
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'
}
export const DEFAULT_HOST_SUBAGENT_PREFERENCES: HostSubagentPreferences = {
  enabledTools: ['read_file', 'read_files', 'glob', 'ripgrep', 'browse_web', 'brave_search', 'edit_file', 'multi_edit', 'multi_call', 'create_file', 'delete_file', 'bash'],
  orchestratorEnabled: true, defaultProvider: null, defaultModel: null, maxTurns: 120, reasoningEffort: 'medium',
}
export function validateHostSubagentPreferences(input: unknown): HostSubagentPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid subagent settings')
  if (Object.keys(input).some(key => !Object.prototype.hasOwnProperty.call(DEFAULT_HOST_SUBAGENT_PREFERENCES, key))) throw new Error('Unknown subagent setting')
  const value = { ...DEFAULT_HOST_SUBAGENT_PREFERENCES, ...input }
  if (!Array.isArray(value.enabledTools) || value.enabledTools.length > 2000 || value.enabledTools.some(name => typeof name !== 'string' || !name || name.length > 200)) throw new Error('Invalid subagent tools')
  if (typeof value.orchestratorEnabled !== 'boolean' || !Number.isSafeInteger(value.maxTurns) || value.maxTurns < 1) throw new Error('Invalid subagent limits')
  if (!['low', 'medium', 'high', 'xhigh'].includes(value.reasoningEffort)) throw new Error('Invalid subagent reasoning effort')
  for (const key of ['defaultProvider', 'defaultModel'] as const) if (value[key] !== null && (typeof value[key] !== 'string' || value[key]!.length > 2048)) throw new Error(`Invalid subagent ${key}`)
  return { ...value, enabledTools: [...value.enabledTools] }
}
