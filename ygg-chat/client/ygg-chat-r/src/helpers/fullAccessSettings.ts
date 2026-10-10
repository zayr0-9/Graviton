// Session-only opt-in: restarting/reloading the renderer restores restricted access.
let fullAccess = false
const listeners = new Set<() => void>()

export const isFullAccessEnabled = (): boolean => fullAccess
export const subscribeFullAccess = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const setFullAccessEnabled = (enabled: boolean): void => {
  fullAccess = enabled === true
  listeners.forEach(listener => listener())
}
