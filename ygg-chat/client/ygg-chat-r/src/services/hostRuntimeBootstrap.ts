import { HOST_CLIENT_PROTOCOL, type HostRuntimeInfo } from '../../../../shared/hostRuntime'
import { isBrowserClient } from '../platform/clientCapabilities'

let runtime: HostRuntimeInfo | null = null
let pending: Promise<HostRuntimeInfo | null> | null = null
let verifiedAt = 0
let verifying: Promise<void> | null = null
let foreignHost = false
export async function verifyBrowserHost(): Promise<void> {
  if (!isBrowserClient || !runtime) return
  if (foreignHost) throw new Error('Another Graviton host is using this address. Reload before continuing; drafts are retained.')
  if (Date.now() - verifiedAt < 1000) return
  if (!verifying) verifying = fetch('/api/host/runtime', { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then(async response => {
    if (!response.ok) throw new Error('The Graviton host is unavailable')
    const current = await response.json()
    if (current.hostId !== runtime!.hostId || current.protocol !== HOST_CLIENT_PROTOCOL) {
      foreignHost = true
      window.dispatchEvent(new CustomEvent('graviton:foreign-host'))
      throw new Error('Another Graviton host is using this address. Reload before continuing; drafts are retained.')
    }
    verifiedAt = Date.now()
  }).finally(() => { verifying = null })
  return verifying
}
export const getHostRuntime = () => runtime
export function bootstrapHostRuntime(): Promise<HostRuntimeInfo | null> {
  if (!isBrowserClient) return Promise.resolve(null)
  if (!pending) pending = fetch('/api/host/runtime', { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    .then(async response => {
      if (!response.ok) throw new Error('The Graviton host is unavailable.')
      const value: HostRuntimeInfo = await response.json()
      if (value.protocol !== HOST_CLIENT_PROTOCOL || !value.epoch || !value.hostId) {
        throw new Error('This browser client is incompatible with the host. Reload after updating Graviton.')
      }
      runtime = value
      verifiedAt = Date.now()
      return value
    }).catch(error => { pending = null; throw error })
  return pending
}
