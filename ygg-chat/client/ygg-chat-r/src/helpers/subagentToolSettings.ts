// Subagent Tool Settings Storage
// Persists subagent configuration to localStorage

const STORAGE_KEY = 'ygg_subagent_tool_settings'
export const SUBAGENT_TOOL_SETTINGS_CHANGE_EVENT = 'ygg-subagent-tool-settings-change'

export interface SubagentToolSettings {
  enabledTools: string[] // Tool names enabled for subagent when orchestratorMode=false
  orchestratorEnabled: boolean // Whether subagent can use tools (orchestrator mode)
  forceOpenAIProviderWhenChatGPTSelected: boolean // Force provider=openaichatgpt when parent chat provider is OpenAI(ChatGPT)
  useGlobalAgentModelAsDefault: boolean // Use Global Agent model from Settings as subagent default model when tool call omits model
}

// Default configuration for non-orchestrator mode
export const DEFAULT_SUBAGENT_TOOLS = ['read_file', 'read_files', 'glob', 'ripgrep', 'browse_web', 'brave_search']

const DEFAULT_SETTINGS: SubagentToolSettings = {
  enabledTools: DEFAULT_SUBAGENT_TOOLS,
  orchestratorEnabled: true, // Subagent can use tools by default
  forceOpenAIProviderWhenChatGPTSelected: true,
  useGlobalAgentModelAsDefault: true,
}

/**
 * Load subagent tool settings from localStorage
 */
export function loadSubagentToolSettings(): SubagentToolSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(stored) as Partial<SubagentToolSettings>
    return {
      enabledTools: parsed.enabledTools ?? DEFAULT_SETTINGS.enabledTools,
      orchestratorEnabled: parsed.orchestratorEnabled ?? DEFAULT_SETTINGS.orchestratorEnabled,
      forceOpenAIProviderWhenChatGPTSelected:
        parsed.forceOpenAIProviderWhenChatGPTSelected ?? DEFAULT_SETTINGS.forceOpenAIProviderWhenChatGPTSelected,
      useGlobalAgentModelAsDefault: parsed.useGlobalAgentModelAsDefault ?? DEFAULT_SETTINGS.useGlobalAgentModelAsDefault,
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

/**
 * Whether subagent calls should force provider=openaichatgpt when the parent provider is OpenAI(ChatGPT)
 */
export function shouldForceSubagentOpenAIProvider(): boolean {
  return loadSubagentToolSettings().forceOpenAIProviderWhenChatGPTSelected
}

export function setForceSubagentOpenAIProvider(enabled: boolean): void {
  const settings = loadSubagentToolSettings()
  settings.forceOpenAIProviderWhenChatGPTSelected = enabled
  saveSubagentToolSettings(settings)
}

/**
 * Whether subagent should default to Global Agent model when the tool call omits model
 */
export function shouldUseGlobalAgentModelForSubagentDefault(): boolean {
  return loadSubagentToolSettings().useGlobalAgentModelAsDefault
}

export function setUseGlobalAgentModelForSubagentDefault(enabled: boolean): void {
  const settings = loadSubagentToolSettings()
  settings.useGlobalAgentModelAsDefault = enabled
  saveSubagentToolSettings(settings)
}

// Deprecated compatibility exports (maxTurns is no longer user-configurable)
export const DEFAULT_MAX_TURNS = 10

export function getDefaultMaxTurns(): number {
  return DEFAULT_MAX_TURNS
}

export function setDefaultMaxTurns(_maxTurns: number): void {
  // Intentionally no-op. Kept for backwards compatibility with legacy callers/tests.
}
