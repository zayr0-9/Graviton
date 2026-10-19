import { buildLocalApiUrl } from '../utils/api'
import { newClientId } from '../helpers/clientId'
import { isFullAccessEnabled } from '../helpers/fullAccessSettings'

export interface HostAppContext { toolName?: string | null; rootPath?: string | null; mode?: 'plan' | 'execute' }
let runtimeContext: () => HostAppContext = () => ({})
export function setHostAppContextProvider(provider: () => HostAppContext): void { runtimeContext = provider }
export const getHostAppContext = (): HostAppContext => runtimeContext()
/** This adapter is called by the source-window-checked parent bridge, not exposed
 * inside iframe global scope. Mutating actions require an explicit parent prompt. */
export function createHostAppClient(getContext: () => HostAppContext) {
  let session: { id: string; key: string } | undefined
  let disposed = false
  let denials = 0
  let tail: Promise<unknown> = Promise.resolve()
  const call = async (method: string, params: Record<string, unknown>, requestId: string) => {
    const context = getContext()
    const launch = { ...context, fullAccess: isFullAccessEnabled() }
    const key = JSON.stringify(launch)
    if (disposed) throw new Error('App view closed')
    if (!['fs.readFile', 'fs.stat'].includes(method)) {
      if (denials >= 3) throw new Error('App actions blocked after repeated denials. Reopen this app view to allow requests again.')
      const target = String(params.filePath ?? params.dirPath ?? params.command ?? params.url ?? params.tool ?? context.toolName ?? '')
      const details = params.args ? '\n' + JSON.stringify(params.args).slice(0, 500) : ''
      if (!window.confirm(`Allow ${context.toolName || 'this app'} to run ${method} on the Graviton host?\n${target.slice(0, 500)}${details}`)) { denials++; throw new Error('App action denied') }
      denials = 0
    }
    if (!session || session.key !== key) {
      const prior = session; session = undefined
      if (prior) await fetch(await buildLocalApiUrl(`/host/apps/sessions/${prior.id}`), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const response = await fetch(await buildLocalApiUrl('/host/apps/sessions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(launch) })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || 'App context unavailable')
      session = { id: value.id, key }
    }
    const url = await buildLocalApiUrl(`/host/apps/sessions/${session.id}/commands`)
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, requestId }) }
    let response: Response
    try { response = await fetch(url, options) } catch { response = await fetch(url, options) }
    const value = await response.json()
    if (!response.ok) { if (response.status === 410) session = undefined; throw new Error(value.error || 'App action unavailable') }
    return value
  }
  return {
    call: (method: string, params: Record<string, unknown>, requestId = newClientId()) => {
      const result = tail.then(() => call(method, params, requestId))
      tail = result.catch(() => {})
      return result
    },
    dispose: () => {
      disposed = true
      if (session) void buildLocalApiUrl(`/host/apps/sessions/${session.id}`).then(url => fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })).catch(() => {})
    },
  }
}
