/**
 * Context directory setting (docs/claude_code_context_loading_rules.md §11.4).
 *
 * Which in-repo directories Graviton reads for rules / skills / agents and which one it
 * writes to. Stored per user in localStorage like the other chat preferences and sent on
 * every chat request as `contextDirectories`.
 */
import {
  CONTEXT_DIRECTORY_PRESETS,
  DEFAULT_CONTEXT_DIRECTORY_SETTINGS,
  detectContextDirectoryPreset,
  normalizeContextDirectorySettings,
  validateContextDirectoryName,
  type ContextDirectoryPreset,
  type ContextDirectorySettings,
} from '../../../../shared/contextDirectories'

export type { ContextDirectoryPreset, ContextDirectorySettings }
export { CONTEXT_DIRECTORY_PRESETS, DEFAULT_CONTEXT_DIRECTORY_SETTINGS, detectContextDirectoryPreset, validateContextDirectoryName }

export const CONTEXT_DIRECTORIES_KEY = 'chat:contextDirectories'
export const CONTEXT_DIRECTORIES_CHANGE_EVENT = 'chat:contextDirectoriesChange'

export const loadContextDirectorySettings = (): ContextDirectorySettings => {
  try {
    const stored = localStorage.getItem(CONTEXT_DIRECTORIES_KEY)
    if (!stored) return { ...DEFAULT_CONTEXT_DIRECTORY_SETTINGS, readDirs: [...DEFAULT_CONTEXT_DIRECTORY_SETTINGS.readDirs] }
    return normalizeContextDirectorySettings(JSON.parse(stored))
  } catch {
    return { ...DEFAULT_CONTEXT_DIRECTORY_SETTINGS, readDirs: [...DEFAULT_CONTEXT_DIRECTORY_SETTINGS.readDirs] }
  }
}

export const saveContextDirectorySettings = (settings: ContextDirectorySettings): ContextDirectorySettings => {
  const normalized = normalizeContextDirectorySettings(settings)
  try {
    localStorage.setItem(CONTEXT_DIRECTORIES_KEY, JSON.stringify(normalized))
    window.dispatchEvent(new CustomEvent<ContextDirectorySettings>(CONTEXT_DIRECTORIES_CHANGE_EVENT, { detail: normalized }))
  } catch {
    // no-op
  }
  return normalized
}
