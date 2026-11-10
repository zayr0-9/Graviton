import { isBrowserClient } from '../platform/clientCapabilities'
const dockStorage = () => isBrowserClient ? sessionStorage : localStorage

export const TERMINAL_DOCK_STORAGE_KEY = 'ygg_terminal_dock_state'
export const TERMINAL_DOCK_CHANGE_EVENT = 'ygg-terminal-dock-change'

export interface TerminalDockPreferences {
  restoreSessionsOnLaunch: boolean
  persistHistory: boolean
}

export interface PersistedTerminalSession {
  id: string
  cwd: string
  title: string
  shell: string
  history: string
}

export interface TerminalDockPersistedState {
  preferences: TerminalDockPreferences
  sessions: PersistedTerminalSession[]
  activeTerminalTabId: string | null
}

const DEFAULT_PREFERENCES: TerminalDockPreferences = {
  restoreSessionsOnLaunch: true,
  persistHistory: true,
}

const DEFAULT_STATE: TerminalDockPersistedState = {
  preferences: { ...DEFAULT_PREFERENCES },
  sessions: [],
  activeTerminalTabId: null,
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeHistory(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeSession(value: unknown): PersistedTerminalSession | null {
  if (!value || typeof value !== 'object') return null

  const session = value as Partial<PersistedTerminalSession>
  const id = normalizeString(session.id)
  const cwd = normalizeString(session.cwd)
  if (!id || !cwd) return null

  return {
    id,
    cwd,
    title: normalizeString(session.title) || 'Terminal',
    shell: normalizeString(session.shell),
    history: normalizeHistory(session.history),
  }
}

function normalizePreferences(value: unknown): TerminalDockPreferences {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES }

  const prefs = value as Partial<TerminalDockPreferences>
  return {
    restoreSessionsOnLaunch:
      typeof prefs.restoreSessionsOnLaunch === 'boolean'
        ? prefs.restoreSessionsOnLaunch
        : DEFAULT_PREFERENCES.restoreSessionsOnLaunch,
    persistHistory:
      typeof prefs.persistHistory === 'boolean' ? prefs.persistHistory : DEFAULT_PREFERENCES.persistHistory,
  }
}

function normalizeState(value: unknown): TerminalDockPersistedState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_STATE }

  const state = value as Partial<TerminalDockPersistedState>
  const sessions = Array.isArray(state.sessions)
    ? state.sessions.map(normalizeSession).filter((item): item is PersistedTerminalSession => Boolean(item))
    : []
  const activeTerminalTabIdRaw = normalizeString(state.activeTerminalTabId)

  return {
    preferences: normalizePreferences(state.preferences),
    sessions,
    activeTerminalTabId: sessions.some(session => session.id === activeTerminalTabIdRaw) ? activeTerminalTabIdRaw : null,
  }
}

async function syncTerminalDockStateToElectronStore(state: TerminalDockPersistedState): Promise<void> {
  if (typeof window === 'undefined') return
  const electronStorage = window.electronAPI?.storage
  if (!electronStorage?.set) return

  try {
    await electronStorage.set(TERMINAL_DOCK_STORAGE_KEY, state)
  } catch (error) {
    console.error('Failed to sync terminal dock state to Electron storage:', error)
  }
}

export function loadTerminalDockState(): TerminalDockPersistedState {
  try {
    const raw = dockStorage().getItem(TERMINAL_DOCK_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : DEFAULT_STATE
    const normalized = normalizeState(parsed)
    void syncTerminalDockStateToElectronStore(normalized)
    return normalized
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function saveTerminalDockState(state: TerminalDockPersistedState): TerminalDockPersistedState {
  const normalized = normalizeState(state)

  try {
    dockStorage().setItem(TERMINAL_DOCK_STORAGE_KEY, JSON.stringify(normalized))
    void syncTerminalDockStateToElectronStore(normalized)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<TerminalDockPersistedState>(TERMINAL_DOCK_CHANGE_EVENT, { detail: normalized }))
    }
  } catch (error) {
    console.error('Failed to save terminal dock state:', error)
  }

  return normalized
}
