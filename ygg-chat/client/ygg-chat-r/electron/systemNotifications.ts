/**
 * OS-level run-completion notifications (macOS Notification Center, Windows
 * toasts, libnotify on Linux). The renderer decides WHICH completions qualify;
 * this module validates, de-duplicates across windows, applies the focus gate and
 * routes clicks back to the main window.
 */
export type RunNotificationPayload = {
  id: string
  kind: 'primary' | 'branch'
  title: string
  body: string
  conversationId: string
  projectId: string | null
  messageId: string
  lineageId: string | null
}

export type RunNotificationOptions = { onlyWhenUnfocused?: boolean; force?: boolean }

export type RunNotificationResult = { shown: true } | { shown: false; reason: 'unsupported' | 'invalid' | 'focused' | 'duplicate' }

const MAX_TITLE = 120
const MAX_BODY = 240
const MAX_ID = 512
// Main outlives renderer reloads, so this also absorbs reattach replays after a reload.
const DEDUP_TTL_MS = 6 * 60 * 60 * 1000
const DEDUP_MAX = 500

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

const optionalId = (value: unknown): string | null => {
  if (value == null) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  return text.length > 0 && text.length <= MAX_ID ? text : null
}

export function normalizeRunNotificationPayload(raw: unknown): RunNotificationPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const id = optionalId(input.id)
  const conversationId = optionalId(input.conversationId)
  const messageId = optionalId(input.messageId)
  if (!id || !conversationId || !messageId) return null
  if (input.kind !== 'primary' && input.kind !== 'branch') return null
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Graviton'
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  return {
    id,
    kind: input.kind,
    title: clip(title, MAX_TITLE),
    body: clip(body, MAX_BODY),
    conversationId,
    projectId: optionalId(input.projectId),
    messageId,
    lineageId: optionalId(input.lineageId),
  }
}

/** The slice of Electron's `Notification` this module uses (injected for tests). */
export interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
}

export type SystemNotifierDeps = {
  isSupported: () => boolean
  createNotification: (options: { title: string; body: string; silent: boolean }) => NativeNotification
  /** True when any app window currently has OS focus. */
  isAppFocused: () => boolean
  /** Bring the main window forward (creating it if needed) and deliver the activation. */
  activate: (payload: RunNotificationPayload) => void
  now?: () => number
}

export function createSystemNotifier(deps: SystemNotifierDeps) {
  const now = deps.now ?? (() => Date.now())
  const recent = new Map<string, number>()
  // Electron drops click events once the Notification object is garbage-collected.
  const live = new Set<NativeNotification>()

  const isDuplicate = (id: string): boolean => {
    const at = now()
    for (const [key, shownAt] of recent) {
      if (at - shownAt > DEDUP_TTL_MS) recent.delete(key)
    }
    if (recent.has(id)) return true
    recent.set(id, at)
    while (recent.size > DEDUP_MAX) {
      const oldest = recent.keys().next().value
      if (oldest === undefined) break
      recent.delete(oldest)
    }
    return false
  }

  const show = (raw: unknown, options?: RunNotificationOptions): RunNotificationResult => {
    if (!deps.isSupported()) return { shown: false, reason: 'unsupported' }
    const payload = normalizeRunNotificationPayload(raw)
    if (!payload) return { shown: false, reason: 'invalid' }
    if (!options?.force && options?.onlyWhenUnfocused && deps.isAppFocused()) return { shown: false, reason: 'focused' }
    if (!options?.force && isDuplicate(payload.id)) return { shown: false, reason: 'duplicate' }

    const notification = deps.createNotification({ title: payload.title, body: payload.body, silent: false })
    live.add(notification)
    const release = () => { live.delete(notification) }
    notification.on('click', () => {
      release()
      deps.activate(payload)
    })
    notification.on('close', release)
    notification.on('failed', release)
    notification.show()
    return { shown: true }
  }

  return { show }
}
