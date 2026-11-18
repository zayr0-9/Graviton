/**
 * The detached agents window: a second Electron window that loads the same app at
 * `#/agents-window` and shows only the agents pill's expanded view, full-window.
 * Electron owns the window (`window:openAgents`); "Open chat" from it is handed to the
 * main window (`window:openInMain`) instead of navigating the agents window.
 */
export const AGENTS_WINDOW_ROUTE = '/agents-window'

export const isAgentsWindow = (): boolean =>
  typeof window !== 'undefined' && window.location.hash.startsWith(`#${AGENTS_WINDOW_ROUTE}`)

export const canOpenAgentsWindow = (): boolean =>
  typeof window !== 'undefined' && typeof window.electronAPI?.window?.openAgents === 'function' && !isAgentsWindow()

export async function openAgentsWindow(): Promise<boolean> {
  try { return (await window.electronAPI?.window?.openAgents?.())?.success === true } catch { return false }
}

/** Show an app route in the main window (focusing it). Returns false when there is no main window. */
export async function openInMainWindow(href: string): Promise<boolean> {
  try { return (await window.electronAPI?.window?.openInMain?.(href))?.success === true } catch { return false }
}
