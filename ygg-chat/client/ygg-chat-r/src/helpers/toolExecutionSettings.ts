import { getHostExecutionPreferences, getHostExecutionRevision, saveHostExecutionPreference } from '../services/hostExecutionClient'
const BASE_REVISION = Symbol('tool-timeouts-base-revision')
const STORAGE_KEY = 'ygg_tool_execution_settings'
export const TOOL_EXECUTION_SETTINGS_CHANGE_EVENT = 'ygg-tool-execution-settings-change'

export const MIN_TOOL_CALL_TIMEOUT_MS = 1000
export const MAX_TOOL_CALL_TIMEOUT_MS = 6000000
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000

export const MIN_STREAM_IDLE_TIMEOUT_MS = 45000
export const MAX_STREAM_IDLE_TIMEOUT_MS = 600000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000

export const MIN_BASH_TIMEOUT_MS = 1000
export const MAX_BASH_TIMEOUT_MS = 600000
export const DEFAULT_BASH_TIMEOUT_MS = 60000

export interface ToolExecutionSettings {
  [BASE_REVISION]?: number
  toolCallTimeoutMs: number
  streamIdleTimeoutMs: number
  bashTimeoutMs: number
}

const DEFAULT_SETTINGS: ToolExecutionSettings = {
  toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  bashTimeoutMs: DEFAULT_BASH_TIMEOUT_MS,
}

function clampToolCallTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TOOL_CALL_TIMEOUT_MS
  }
  return Math.max(MIN_TOOL_CALL_TIMEOUT_MS, Math.min(MAX_TOOL_CALL_TIMEOUT_MS, Math.floor(value)))
}

function clampStreamIdleTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  }
  return Math.max(MIN_STREAM_IDLE_TIMEOUT_MS, Math.min(MAX_STREAM_IDLE_TIMEOUT_MS, Math.floor(value)))
}

function clampBashTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BASH_TIMEOUT_MS
  }
  return Math.max(MIN_BASH_TIMEOUT_MS, Math.min(MAX_BASH_TIMEOUT_MS, Math.floor(value)))
}

async function syncToolExecutionSettingsToElectronStore(settings: ToolExecutionSettings): Promise<void> {
  if (typeof window === 'undefined') return

  const electronStorage = window.electronAPI?.storage
  if (!electronStorage?.set) return

  try {
    await electronStorage.set(STORAGE_KEY, settings)
  } catch (error) {
    console.error('Failed to sync tool execution settings to Electron storage:', error)
  }
}

export function loadToolExecutionSettings(): ToolExecutionSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    let parsed: Partial<ToolExecutionSettings> = {}
    try { parsed = stored ? JSON.parse(stored) : {} } catch { /* Corrupt client watchdog settings cannot hide canonical host values. */ }
    const host = getHostExecutionPreferences()
    if (host) return { ...host.toolTimeouts, streamIdleTimeoutMs: clampStreamIdleTimeoutMs(parsed.streamIdleTimeoutMs), [BASE_REVISION]: getHostExecutionRevision('toolTimeouts') }
    if (!stored) return { ...DEFAULT_SETTINGS }
    const normalized = {
      toolCallTimeoutMs: clampToolCallTimeoutMs(parsed.toolCallTimeoutMs),
      streamIdleTimeoutMs: clampStreamIdleTimeoutMs(parsed.streamIdleTimeoutMs),
      bashTimeoutMs: clampBashTimeoutMs(parsed.bashTimeoutMs),
    }

    void syncToolExecutionSettingsToElectronStore(normalized)
    return normalized
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveToolExecutionSettings(settings: ToolExecutionSettings): Promise<void> {
  const normalized: ToolExecutionSettings = {
    toolCallTimeoutMs: clampToolCallTimeoutMs(settings.toolCallTimeoutMs),
    streamIdleTimeoutMs: clampStreamIdleTimeoutMs(settings.streamIdleTimeoutMs),
    bashTimeoutMs: clampBashTimeoutMs(settings.bashTimeoutMs),
  }

  if (getHostExecutionPreferences()) {
    const revision = settings[BASE_REVISION]
    if (!Number.isSafeInteger(revision)) throw new Error('Reload tool settings before saving')
    const toolTimeouts = { toolCallTimeoutMs: normalized.toolCallTimeoutMs, bashTimeoutMs: normalized.bashTimeoutMs }
    const current = getHostExecutionPreferences()!.toolTimeouts
    if (current.toolCallTimeoutMs !== toolTimeouts.toolCallTimeoutMs || current.bashTimeoutMs !== toolTimeouts.bashTimeoutMs)
      await saveHostExecutionPreference({ toolTimeouts }, revision)
    settings[BASE_REVISION] = getHostExecutionRevision('toolTimeouts')
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ streamIdleTimeoutMs: normalized.streamIdleTimeoutMs }))
    window.dispatchEvent(new CustomEvent(TOOL_EXECUTION_SETTINGS_CHANGE_EVENT, { detail: settings }))
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    void syncToolExecutionSettingsToElectronStore(normalized)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(TOOL_EXECUTION_SETTINGS_CHANGE_EVENT, { detail: normalized }))
    }
  } catch (error) {
    console.error('Failed to save tool execution settings:', error)
  }
}

export function getDefaultToolCallTimeoutMs(): number {
  return loadToolExecutionSettings().toolCallTimeoutMs
}

export function getStreamIdleTimeoutMs(): number {
  return loadToolExecutionSettings().streamIdleTimeoutMs
}

export function getDefaultBashTimeoutMs(): number {
  return loadToolExecutionSettings().bashTimeoutMs
}
