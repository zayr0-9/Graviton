import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { win32 } from 'node:path'

interface RecoveryOptions {
  entryUrl: string
  isQuitting: () => boolean
  log: (record: Record<string, unknown>) => void
  logPath: () => string
  versions: { app: string; electron: string; chrome: string; platform: string; arch: string }
  showDialog: (options: MessageBoxOptions) => Promise<{ response: number }>
  changed: () => void
}

interface Incident {
  id: string
  ts: string
  reason: string
  exitCode?: number
  errorCode?: number
}

const reasons = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])

/** Main-owned: works when React/preload are gone, and never owns the server. */
export function installRendererRecovery(window: BrowserWindow, options: RecoveryOptions) {
  const contents = window.webContents
  const entry = new URL(options.entryUrl)
  let target = entry.href
  let disposed = false
  let incident: Incident | null = null
  let loading = false
  let attempt = 0
  let dialogOpen = false
  let dialogPending = false
  let lastPromptedIncident: Incident | null = null
  let everShown = window.isVisible()
  let sessionEnding = false

  const alive = () => !disposed && !sessionEnding && !options.isQuitting() && !window.isDestroyed() && !contents.isDestroyed()
  const notify = () => {
    try { options.changed() } catch {
      console.error('[Electron recovery] Could not refresh native recovery menu')
    }
  }
  const record = (event: string, failure: Incident, extra: Record<string, unknown> = {}) => {
    try {
      options.log({ ts: new Date().toISOString(), type: 'renderer_recovery', event,
        incidentId: failure.id, reason: failure.reason, exitCode: failure.exitCode,
        errorCode: failure.errorCode, windowId: window.id, webContentsId: contents.id,
        versions: options.versions, ...extra })
    } catch {
      // Never include a raw error here: paths/URLs or renderer data may be embedded in it.
      console.error('[Electron recovery] Could not write diagnostic record:', event, failure.reason)
    }
  }
  const trusted = (url: string) => {
    try {
      const candidate = new URL(url)
      const filePath = (value: URL) => win32.normalize(fileURLToPath(value, { windows: true }))
        .replace(/^[a-z]:/, drive => drive.toUpperCase())
      const samePath = options.versions.platform === 'win32' && entry.protocol === 'file:' && candidate.protocol === 'file:'
        ? filePath(candidate) === filePath(entry)
        : candidate.pathname === entry.pathname
      return candidate.protocol === entry.protocol && candidate.host === entry.host &&
        samePath && candidate.search === entry.search && !candidate.username && !candidate.password
    } catch { return false }
  }

  async function prompt() {
    if (!alive() || !incident || loading || !window.isVisible() || window.isMinimized()) return
    if (dialogOpen) return
    dialogOpen = true
    const failure = incident
    lastPromptedIncident = failure
    const ticket = attempt
    let logLocation = 'Diagnostic log unavailable'
    try { logLocation = options.logPath() } catch { /* Recovery must work without writable logs. */ }
    try {
      const result = await options.showDialog({
        type: 'error', title: 'Recover Graviton',
        message: failure.reason === 'load-failed'
          ? 'Graviton’s interface could not load.' : 'Graviton’s interface stopped unexpectedly.',
        detail: [
          failure.reason === 'oom' ? 'Electron reported that the interface ran out of memory.' : 'The interface could not continue.',
          'Reload UI restarts only the interface, not the local server. Server-owned agents are not deliberately stopped. Unsaved interface state may be lost.',
          `Reason: ${failure.reason}`,
          failure.exitCode == null ? '' : `Exit code: ${failure.exitCode}`,
          failure.errorCode == null ? '' : `Load error code: ${failure.errorCode}`,
          `Time: ${failure.ts}`, `Incident: ${failure.id}`, `Diagnostics: ${logLocation}`,
          'If you choose Later, use Recover UI… in the Graviton tray menu.',
        ].filter(Boolean).join('\n\n'),
        buttons: ['Reload UI', 'Later'], defaultId: 0, cancelId: 1, noLink: true,
      })
      if (alive() && incident === failure && ticket === attempt && result.response === 0) {
        record('reload_requested', failure)
        void load(true)
      }
    } catch {
      if (alive() && incident === failure) record('dialog_failed', failure)
    } finally {
      dialogOpen = false
      // A different failure can arrive while the OS dialog is still open.
      if (dialogPending) { dialogPending = false; void prompt() }
    }
  }

  function fail(reason: string, details: { exitCode?: number; errorCode?: number } = {}) {
    if (!alive()) return
    loading = false
    attempt++
    incident = { id: randomUUID(), ts: new Date().toISOString(), reason, ...details }
    record('failed', incident)
    notify()
    if (dialogOpen) dialogPending = true
    // Launching the app is already a user action. Do not strand a failed first
    // paint behind ready-to-show; later hide-to-tray crashes remain hidden.
    if (!everShown && !window.isMinimized()) window.show()
    void prompt()
  }

  async function load(recovery = false) {
    if (!alive() || loading) return
    const ticket = ++attempt
    const failure = incident
    loading = true
    notify()
    try {
      await contents.loadURL(target)
      if (!alive() || ticket !== attempt) return
      loading = false
      incident = null
      if (recovery && failure) record('document_loaded', failure)
      notify()
    } catch (error) {
      if (!alive() || ticket !== attempt) return
      // Electron emits did-fail-load AND rejects loadURL; the event invalidates
      // this ticket so one navigation failure never becomes two dialogs.
      if ((error as { code?: string })?.code === 'ERR_ABORTED') {
        if (failure) record('reload_aborted', failure)
        loading = false
        notify()
        return
      }
      if (failure) record('reload_failed', failure)
      fail('load-failed')
    }
  }

  const gone = (_event: unknown, details: { reason: string; exitCode: number }) => {
    if (!alive()) return
    const reason = reasons.has(details.reason) ? details.reason : 'unknown'
    if (reason === 'clean-exit') {
      record('clean_exit', { id: randomUUID(), ts: new Date().toISOString(), reason })
      return
    }
    fail(reason, { exitCode: Number.isFinite(details.exitCode) ? details.exitCode : undefined })
  }
  const failedLoad = (_event: unknown, code: number, _description: string, _url: string, mainFrame: boolean) => {
    if (!mainFrame || code === -3 || !alive()) return
    if (loading && incident) record('reload_failed', incident, { errorCode: code })
    fail('load-failed', { errorCode: code })
  }
  const navigated = (_event: unknown, url: string, mainFrame = true) => {
    if (!mainFrame || !trusted(url)) return
    target = url
    if (!loading && incident) {
      attempt++
      incident = null
      notify()
    }
  }
  const mainNavigated = (event: unknown, url: string) => navigated(event, url, true)
  const shown = () => {
    everShown = true
    if (incident && incident !== lastPromptedIncident && !dialogOpen) void prompt()
  }
  const sessionEnd = () => { sessionEnding = true; attempt++ }
  const dispose = () => {
    disposed = true
    attempt++
    contents.removeListener('render-process-gone', gone)
    contents.removeListener('did-fail-load', failedLoad)
    contents.removeListener('did-navigate', mainNavigated)
    contents.removeListener('did-navigate-in-page', navigated)
    window.removeListener('show', shown)
    window.removeListener('restore', shown)
    window.removeListener('focus', shown)
    window.removeListener('session-end', sessionEnd)
    window.removeListener('closed', dispose)
  }
  contents.on('render-process-gone', gone)
  contents.on('did-fail-load', failedLoad)
  contents.on('did-navigate', mainNavigated)
  contents.on('did-navigate-in-page', navigated)
  window.on('show', shown)
  window.on('restore', shown)
  window.on('focus', shown)
  window.on('session-end', sessionEnd)
  window.once('closed', dispose)

  return {
    load: () => load(),
    needsRecovery: () => alive() && incident !== null && !loading,
    recover: () => {
      if (!alive() || !incident || loading) return
      // Explicit user intent must survive asynchronous macOS restore/show.
      lastPromptedIncident = null
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      void prompt()
    },
    dispose,
  }
}

export type RendererRecovery = ReturnType<typeof installRendererRecovery>
