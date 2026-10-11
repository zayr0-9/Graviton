// Session-only opt-in: restarting/reloading the renderer restores restricted access.
let fullAccess = false
const listeners = new Set<() => void>()
// A toggle queues a notice for that conversation only. It never changes a live run.
const pendingNotifications = new Map<string, string>()

export const isFullAccessEnabled = (): boolean => fullAccess
export const subscribeFullAccess = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const setFullAccessEnabled = (enabled: boolean, conversationId?: string | number | null): void => {
  const wasEnabled = fullAccess
  fullAccess = enabled === true
  if (!fullAccess) pendingNotifications.clear()
  else if (!wasEnabled && conversationId != null) {
    pendingNotifications.set(String(conversationId), crypto.randomUUID())
  }
  listeners.forEach(listener => listener())
}

export const getPendingFullAccessNotification = (conversationId: string): string | undefined =>
  fullAccess ? pendingNotifications.get(conversationId) : undefined

// Acknowledge only the exact notice that reached durable history. A later toggle
// must not be consumed by an older stream finishing or replaying its frames.
export const acknowledgeFullAccessNotification = (conversationId: string, requestId: string): void => {
  if (pendingNotifications.get(conversationId) === requestId) pendingNotifications.delete(conversationId)
}
