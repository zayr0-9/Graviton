// Subagent Tool Settings Storage
// Persists subagent configuration to localStorage

const STORAGE_KEY = 'ygg_subagent_tool_settings'
export const SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT = 'ygg-subagent-tool-settings-change'

export const SUBAGENT_REASONING_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh'] as const
export type SubagentReasoningEffort = (typeof SUBAGENT_REASONING_EFFORT_OPTIONS)[number]

export interface SubagentToolSettings {
  enabledTools: string[] // Tool names enabled for subagent when orchestratorMode=false
  orchestratorEnabled: boolean // Whether subagent can use tools (orchestrator mode)
  defaultProvider: string | null // Provider used by subagents; null follows the current chat provider
  defaultModel: string | null // Model used by subagents; null follows the selected/default model for the resolved provider
  maxTurns: number // Maximum model/tool loop turns for one subagent invocation
  reasoningEffort: SubagentReasoningEffort // OpenAI ChatGPT reasoning effort for subagent runs
}

export const DEFAULT_SUBAGENT_MAX_TURNS = 120
const DEFAULT_SUBAGENT_REASONING_EFFORT: SubagentReasoningEffort = 'medium'

const normalizeReasoningEffort = (value: unknown): SubagentReasoningEffort =>
  SUBAGENT_REASONING_EFFORT_OPTIONS.includes(value as SubagentReasoningEffort)
    ? (value as SubagentReasoningEffort)
    : DEFAULT_SUBAGENT_REASONING_EFFORT

const normalizeMaxTurns = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUBAGENT_MAX_TURNS
  return Math.floor(parsed)
}

// Default configuration for non-orchestrator mode
export const DEFAULT_SUBAGENT_TOOLS = [
  'read_file',
  'read_files',
  'glob',
  'ripgrep',
  'browse_web',
  'brave_search',
  'edit_file',
  'multi_edit',
  'create_file',
  'delete_file',
  'bash',
]

const DEFAULT_SETTINGS: SubagentToolSettings = {
  enabledTools: DEFAULT_SUBAGENT_TOOLS,
  orchestratorEnabled: true, // Subagent can use tools by default
  defaultProvider: null,
  defaultModel: null,
  maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
  reasoningEffort: DEFAULT_SUBAGENT_REASONING_EFFORT,
}

/**
 * Load subagent tool settings from localStorage
 */
export function loadSubagentToolSettings(): SubagentToolSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(stored) as Partial<SubagentToolSettings>
    const defaultProvider = typeof parsed.defaultProvider === 'string' && parsed.defaultProvider.trim()
      ? parsed.defaultProvider.trim()
      : null
    const defaultModel = typeof parsed.defaultModel === 'string' && parsed.defaultModel.trim()
      ? parsed.defaultModel.trim()
      : null

    return {
      enabledTools: parsed.enabledTools ?? DEFAULT_SETTINGS.enabledTools,
      orchestratorEnabled: parsed.orchestratorEnabled ?? DEFAULT_SETTINGS.orchestratorEnabled,
      defaultProvider,
      defaultModel,
      maxTurns: normalizeMaxTurns(parsed.maxTurns ?? DEFAULT_SETTINGS.maxTurns),
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Save subagent tool settings to localStorage
 */
export function saveSubagentToolSettings(settings: SubagentToolSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT, { detail: settings }))
    }
  } catch (error) {
    console.error('[SubagentToolSettings] Failed to save settings:', error)
  }
}

/**
 * Get the list of enabled tools for subagent (non-orchestrator mode)
 */
export function getSubagentEnabledTools(): string[] {
  const settings = loadSubagentToolSettings()
  return settings.enabledTools
}

/**
 * Set the list of enabled tools for subagent
 */
export function setSubagentEnabledTools(tools: string[]): void {
  const settings = loadSubagentToolSettings()
  settings.enabledTools = tools
  saveSubagentToolSettings(settings)
}

/**
 * Check if orchestrator mode is enabled for subagents
 */
export function isOrchestratorEnabled(): boolean {
  const settings = loadSubagentToolSettings()
  return settings.orchestratorEnabled
}

/**
 * Set orchestrator mode enabled/disabled
 */
export function setOrchestratorEnabled(enabled: boolean): void {
  const settings = loadSubagentToolSettings()
  settings.orchestratorEnabled = enabled
  saveSubagentToolSettings(settings)
}

/**
 * Toggle orchestrator mode
 */
export function toggleOrchestratorEnabled(): boolean {
  const settings = loadSubagentToolSettings()
  settings.orchestratorEnabled = !settings.orchestratorEnabled
  saveSubagentToolSettings(settings)
  return settings.orchestratorEnabled
}

export function getSubagentDefaultProvider(): string | null {
  return loadSubagentToolSettings().defaultProvider
}

export function setSubagentDefaultProvider(provider: string | null): void {
  const settings = loadSubagentToolSettings()
  settings.defaultProvider = typeof provider === 'string' && provider.trim() ? provider.trim() : null
  settings.defaultModel = null
  saveSubagentToolSettings(settings)
}

export function getSubagentDefaultModel(): string | null {
  return loadSubagentToolSettings().defaultModel
}

export function setSubagentDefaultModel(model: string | null): void {
  const settings = loadSubagentToolSettings()
  settings.defaultModel = typeof model === 'string' && model.trim() ? model.trim() : null
  saveSubagentToolSettings(settings)
}

export function getSubagentMaxTurns(): number {
  return loadSubagentToolSettings().maxTurns
}

export function setSubagentMaxTurns(maxTurns: number): void {
  const settings = loadSubagentToolSettings()
  settings.maxTurns = normalizeMaxTurns(maxTurns)
  saveSubagentToolSettings(settings)
}

// Deprecated compatibility exports
export const DEFAULT_MAX_TURNS = DEFAULT_SUBAGENT_MAX_TURNS

export function getDefaultMaxTurns(): number {
  return getSubagentMaxTurns()
}

export function setDefaultMaxTurns(maxTurns: number): void {
  setSubagentMaxTurns(maxTurns)
}

export function getSubagentReasoningEffort(): SubagentReasoningEffort {
  return loadSubagentToolSettings().reasoningEffort
}

export function setSubagentReasoningEffort(reasoningEffort: SubagentReasoningEffort): void {
  const settings = loadSubagentToolSettings()
  settings.reasoningEffort = normalizeReasoningEffort(reasoningEffort)
  saveSubagentToolSettings(settings)
}
