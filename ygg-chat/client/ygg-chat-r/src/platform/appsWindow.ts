/**
 * The detached apps window: a second Electron window that loads the same app at
 * `#/apps-window` and shows only the Task Manager. It is a move, not a copy: while it is open
 * it owns the HTML/MCP app iframes, and the main window keeps only the entry list and
 * forwards "open this app" requests to it. Closing it hands the list back.
 * Iframes cannot move between windows, so each app reloads when it changes window.
 */
import { isAgentsWindow } from './agentsWindow'

export const APPS_WINDOW_ROUTE = '/apps-window'

export type AppsHandoffMode = 'replace' | 'merge'

/** Task Manager entries as JSON, plus the app to focus. `replace` hands over the whole list. */
export type AppsHandoff<Entry = unknown> = { mode: AppsHandoffMode; entries: Entry[]; focusKey: string | null }

export const isAppsWindow = (): boolean =>
  typeof window !== 'undefined' && window.location.hash.startsWith(`#${APPS_WINDOW_ROUTE}`)

/** True in the Electron main window (not the agents or apps window). */
export const canOpenAppsWindow = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.electronAPI?.window?.openApps === 'function' &&
  !isAppsWindow() &&
  !isAgentsWindow()

export async function openAppsWindow(handoff: AppsHandoff): Promise<boolean> {
  try {
    return (await window.electronAPI?.window?.openApps?.(handoff))?.success === true
  } catch {
    return false
  }
}

export async function isAppsWindowOpen(): Promise<boolean> {
  try {
    return (await window.electronAPI?.window?.isAppsOpen?.()) === true
  } catch {
    return false
  }
}

export const onAppsWindowChanged = (callback: (open: boolean) => void): (() => void) | undefined =>
  window.electronAPI?.window?.onAppsWindowChanged?.(callback)

export async function takeAppsReturn(): Promise<AppsHandoff | null> {
  try {
    return parseAppsHandoff(await window.electronAPI?.window?.takeAppsReturn?.())
  } catch {
    return null
  }
}

export const onAppsHandoff = (callback: (handoffs: AppsHandoff[]) => void): (() => void) | undefined =>
  window.electronAPI?.window?.onAppsHandoff?.(raw =>
    callback(raw.map(parseAppsHandoff).filter((handoff): handoff is AppsHandoff => handoff !== null))
  )

export function reportAppsSnapshot(entries: unknown[]): void {
  try {
    window.electronAPI?.window?.reportApps?.({ mode: 'replace', entries, focusKey: null })
  } catch {
    /* The window is closing; the last report stands. */
  }
}

export function parseAppsHandoff(value: unknown): AppsHandoff | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { mode?: unknown; entries?: unknown; focusKey?: unknown }
  if ((raw.mode !== 'replace' && raw.mode !== 'merge') || !Array.isArray(raw.entries)) return null
  return { mode: raw.mode, entries: raw.entries, focusKey: typeof raw.focusKey === 'string' ? raw.focusKey : null }
}
