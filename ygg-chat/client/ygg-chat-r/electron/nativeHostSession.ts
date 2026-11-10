import type { Session } from 'electron'
import { getNativeClientFence, nativeClientHeader } from '../server/nativeClientFence.js'

/** Install on the actual window session, even if it predates session-created. */
export function createNativeHostSessionInstaller(getOrigin: () => string | null, ownsWebContents: (id: number) => boolean) {
  const installed = new WeakSet<Session>()
  return (nativeSession: Session): void => {
    if (installed.has(nativeSession)) return
    installed.add(nativeSession)
    nativeSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      try {
        const origin = getOrigin()
        if (typeof details.webContentsId === 'number' && ownsWebContents(details.webContentsId) && origin && new URL(details.url).origin === new URL(origin).origin) {
          headers[nativeClientHeader] = getNativeClientFence()
        }
      } catch { /* Unsupported URLs retain their original headers. */ }
      callback({ requestHeaders: headers })
    })
  }
}
