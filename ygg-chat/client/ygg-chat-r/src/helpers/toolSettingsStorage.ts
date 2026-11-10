// Tool Settings Storage
// Persists tool enabled/disabled states to localStorage

import { getHostExecutionPreferences, saveHostExecutionPreference } from '../services/hostExecutionClient'
const STORAGE_KEY = 'ygg_tool_settings'

export interface ToolEnabledStates {
  [toolName: string]: boolean
}

/**
 * Load tool enabled states from localStorage
 */
export function loadToolEnabledStates(): ToolEnabledStates {
  const host = getHostExecutionPreferences()
  if (host) return { ...host.tools }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return {}
    return JSON.parse(stored) as ToolEnabledStates
  } catch {
    return {}
  }
}

/**
 * Save tool enabled states to localStorage
 */
export async function saveToolEnabledStates(states: ToolEnabledStates): Promise<void> {
  if (getHostExecutionPreferences()) { await saveHostExecutionPreference({ tools: states }); return }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(states))
  } catch (error) {
    console.error('[ToolSettings] Failed to save tool states:', error)
  }
}

/**
 * Update a single tool's enabled state and persist
 */
export async function updateToolEnabledState(toolName: string, enabled: boolean): Promise<void> {
  if (getHostExecutionPreferences()) { await saveHostExecutionPreference({ tools: { [toolName]: enabled } }); return }
  const states = loadToolEnabledStates()
  states[toolName] = enabled
  await saveToolEnabledStates(states)
}

/**
 * Get a tool's persisted enabled state (or undefined if not set)
 */
export function getToolEnabledState(toolName: string): boolean | undefined {
  const states = loadToolEnabledStates()
  return states[toolName]
}

/**
 * Apply persisted states to a list of tools
 * Returns the tools with their enabled states updated from localStorage
 */
export function applyPersistedToolStates<T extends { name: string; enabled: boolean }>(tools: T[]): T[] {
  const states = loadToolEnabledStates()
  return tools.map(tool => {
    if (states[tool.name] !== undefined) {
      return { ...tool, enabled: states[tool.name] }
    }
    return tool
  })
}
