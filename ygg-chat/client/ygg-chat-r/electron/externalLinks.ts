import type { BrowserWindow, MessageBoxOptions, WebContents } from 'electron'
import { fileURLToPath } from 'node:url'
import { win32 } from 'node:path'
import { editorFilePath, externalLinkKind, urlScheme } from '../shared/linkPolicy.js'

export interface OpenLinkResult { success: boolean; error?: string; cancelled?: boolean }

interface ExternalLinkDeps {
  platform: string
  openExternal: (url: string) => Promise<void>
  /** Returns '' on success or an error message, like Electron's shell.openPath. */
  openPath: (path: string) => Promise<string>
  showDialog: (parent: BrowserWindow | null, options: MessageBoxOptions) => Promise<{ response: number; checkboxChecked?: boolean }>
}

const MAX_DIALOG_URL = 300

/**
 * The single place main hands a renderer-supplied link to the OS. Web, mail and editor links
 * open directly; other app schemes need a native confirmation; dangerous schemes are refused.
 */
export function createExternalLinkOpener(deps: ExternalLinkDeps) {
  // Schemes the user approved with "don't ask again" this session.
  const approvedSchemes = new Set<string>()

  async function openPathResult(path: string): Promise<OpenLinkResult> {
    try {
      const error = await deps.openPath(path)
      return error ? { success: false, error } : { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  async function openExternalLink(url: unknown, parent: BrowserWindow | null = null): Promise<OpenLinkResult> {
    if (typeof url !== 'string' || !url.trim()) return { success: false, error: 'A link URL is required' }
    const target = url.trim()
    const kind = externalLinkKind(target, deps.platform)
    const scheme = urlScheme(target)

    if (kind === 'blocked') return { success: false, error: `Links using ${scheme ?? 'this'}: are not opened` }
    if (kind === 'file') return openPathResult(target)

    if (kind === 'web') {
      try { new URL(target) } catch { return { success: false, error: 'Invalid web link' } }
    }

    if (kind === 'app' && !approvedSchemes.has(scheme!)) {
      const shown = target.length > MAX_DIALOG_URL ? `${target.slice(0, MAX_DIALOG_URL)}…` : target
      const { response, checkboxChecked } = await deps.showDialog(parent, {
        type: 'question',
        message: 'Open link in another app?',
        detail: `This ${scheme}: link will be opened by whichever app your system has registered for it.\n\n${shown}`,
        buttons: ['Open', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel: `Don't ask again for ${scheme}: links this session`,
      })
      if (response !== 0) return { success: false, cancelled: true }
      if (checkboxChecked) approvedSchemes.add(scheme!)
    }

    try {
      await deps.openExternal(target)
      return { success: true }
    } catch (error) {
      // No editor registered for the scheme: open the file itself in the OS default app.
      const fallbackPath = kind === 'editor' ? editorFilePath(target) : null
      if (fallbackPath) return openPathResult(fallbackPath)
      return { success: false, error: String(error) }
    }
  }

  return { openExternalLink }
}

/** True when `url` is the app's own document (same entry file/origin path and search). */
export function isAppDocumentUrl(entryUrl: string | URL, url: string, platform: string): boolean {
  try {
    const entry = typeof entryUrl === 'string' ? new URL(entryUrl) : entryUrl
    const candidate = new URL(url)
    const filePath = (value: URL) => win32.normalize(fileURLToPath(value, { windows: true }))
      .replace(/^[a-z]:/, drive => drive.toUpperCase())
    const samePath = platform === 'win32' && entry.protocol === 'file:' && candidate.protocol === 'file:'
      ? filePath(candidate) === filePath(entry)
      : candidate.pathname === entry.pathname
    return candidate.protocol === entry.protocol && candidate.host === entry.host &&
      samePath && candidate.search === entry.search && !candidate.username && !candidate.password
  } catch { return false }
}

type GuardedWindow = Pick<BrowserWindow, 'isDestroyed'> & {
  webContents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>
}

/**
 * Keeps a window on its app document. Links that would navigate it or open a new Electron
 * window are routed to the OS instead (file → openPath, everything else → openExternalLink).
 */
export function installNavigationGuards(
  window: GuardedWindow,
  entryUrl: string,
  platform: string,
  openLink: (url: string) => Promise<OpenLinkResult>,
) {
  const route = (url: string) => {
    void openLink(url)
      .then(result => { if (!result.success && !result.cancelled) console.warn('[Electron] Link not opened:', result.error) })
      .catch(error => console.error('[Electron] Failed to open link:', error))
  }

  window.webContents.on('will-navigate', (event, url) => {
    if (isAppDocumentUrl(entryUrl, url, platform)) return
    event.preventDefault()
    route(url)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    route(url)
    return { action: 'deny' }
  })
}
