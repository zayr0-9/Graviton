/**
 * OS run-completion notification preferences (Settings → System notifications).
 * Renderer-local, shared by the main and floating windows through their common
 * origin. Read at completion time, so changes apply without a reload.
 */
export type SystemNotificationWhen = 'unfocused' | 'always'

export type SystemNotificationPrefs = {
  enabled: boolean
  when: SystemNotificationWhen
}

export const SYSTEM_NOTIFICATIONS_ENABLED_KEY = 'notifications:runCompletion:enabled'
export const SYSTEM_NOTIFICATIONS_WHEN_KEY = 'notifications:runCompletion:when'

export const DEFAULT_SYSTEM_NOTIFICATION_PREFS: SystemNotificationPrefs = { enabled: true, when: 'unfocused' }

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readSystemNotificationPrefs(): SystemNotificationPrefs {
  const store = storage()
  if (!store) return { ...DEFAULT_SYSTEM_NOTIFICATION_PREFS }
  try {
    const enabled = store.getItem(SYSTEM_NOTIFICATIONS_ENABLED_KEY)
    const when = store.getItem(SYSTEM_NOTIFICATIONS_WHEN_KEY)
    return {
      enabled: enabled == null ? DEFAULT_SYSTEM_NOTIFICATION_PREFS.enabled : enabled !== 'false',
      when: when === 'always' || when === 'unfocused' ? when : DEFAULT_SYSTEM_NOTIFICATION_PREFS.when,
    }
  } catch {
    return { ...DEFAULT_SYSTEM_NOTIFICATION_PREFS }
  }
}

export function writeSystemNotificationPrefs(patch: Partial<SystemNotificationPrefs>): SystemNotificationPrefs {
  const next = { ...readSystemNotificationPrefs(), ...patch }
  const store = storage()
  try {
    store?.setItem(SYSTEM_NOTIFICATIONS_ENABLED_KEY, String(next.enabled))
    store?.setItem(SYSTEM_NOTIFICATIONS_WHEN_KEY, next.when)
  } catch {
    // Storage full/blocked: keep the in-memory value for this session's UI.
  }
  return next
}
