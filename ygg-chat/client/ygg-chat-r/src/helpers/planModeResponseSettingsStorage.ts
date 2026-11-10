import { getHostExecutionPreferences, saveHostExecutionPreference } from '../services/hostExecutionClient'
const STORAGE_KEY = 'ygg_plan_mode_response_settings'
export const PLAN_MODE_RESPONSE_SETTINGS_CHANGE_EVENT = 'ygg-plan-mode-response-settings-change'

export const PLAN_MODE_VERBOSITY_OPTIONS = ['concise', 'normal', 'detailed'] as const
export type PlanModeVerbosity = (typeof PLAN_MODE_VERBOSITY_OPTIONS)[number]

export interface PlanModeResponseSettings {
  verbosity: PlanModeVerbosity
}

const DEFAULT_SETTINGS: PlanModeResponseSettings = {
  verbosity: 'concise',
}

export function normalizePlanModeVerbosity(value: unknown): PlanModeVerbosity {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.verbosity
  return PLAN_MODE_VERBOSITY_OPTIONS.includes(value as PlanModeVerbosity)
    ? (value as PlanModeVerbosity)
    : DEFAULT_SETTINGS.verbosity
}

export function normalizePlanModeResponseSettings(
  settings: Partial<PlanModeResponseSettings> | null | undefined
): PlanModeResponseSettings {
  return {
    verbosity: normalizePlanModeVerbosity(settings?.verbosity),
  }
}

export function getDefaultPlanModeResponseSettings(): PlanModeResponseSettings {
  return { ...DEFAULT_SETTINGS }
}

export function loadPlanModeResponseSettings(): PlanModeResponseSettings {
  const host = getHostExecutionPreferences()
  if (host) return { verbosity: host.planModeVerbosity }
  try {
    if (typeof localStorage === 'undefined') return getDefaultPlanModeResponseSettings()
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return getDefaultPlanModeResponseSettings()

    return normalizePlanModeResponseSettings(JSON.parse(stored) as Partial<PlanModeResponseSettings>)
  } catch {
    return getDefaultPlanModeResponseSettings()
  }
}

export async function savePlanModeResponseSettings(settings: PlanModeResponseSettings): Promise<PlanModeResponseSettings> {
  const normalized = normalizePlanModeResponseSettings(settings)
  if (getHostExecutionPreferences()) { await saveHostExecutionPreference({ planModeVerbosity: normalized.verbosity }); return normalized }

  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PLAN_MODE_RESPONSE_SETTINGS_CHANGE_EVENT, { detail: normalized }))
    }
  } catch (error) {
    console.error('Failed to save Plan Mode response settings:', error)
  }

  return normalized
}
