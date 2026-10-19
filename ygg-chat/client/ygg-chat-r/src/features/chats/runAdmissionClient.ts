import type { RunAdmissionReceipt } from '../../../../../shared/runAdmission'
import { buildLocalApiUrl } from '../../utils/api'
import { getHostRuntime } from '../../services/hostRuntimeBootstrap'

let epoch: string | undefined
let restarted = false
export function resetAdmissionEpoch(): void { epoch = undefined; restarted = true }
export async function getAdmissionEpoch(signal?: AbortSignal): Promise<string> {
  if (!epoch) {
    epoch = restarted ? undefined : getHostRuntime()?.epoch
    if (!epoch) {
      const response = await fetch(await buildLocalApiUrl('/host/runtime'), { signal, cache: 'no-store' })
      if (!response.ok) {
        const reason = response.status === 404
          ? 'The running Graviton host is older than this UI. Fully quit all Graviton copies, then launch the newly installed app.'
          : response.status === 403
            ? 'The host rejected this window. Fully restart Graviton; if it persists, report the host access-policy error.'
            : 'Check that the Graviton host is running and restart it if needed.'
        throw new Error(`Host bootstrap unavailable (HTTP ${response.status}). ${reason}`)
      }
      const runtime = await response.json()
      if (typeof runtime.epoch !== 'string') throw new Error('Invalid host epoch')
      epoch = runtime.epoch
    }
  }
  return epoch!
}

export async function admitRun(conversationId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<RunAdmissionReceipt> {
  const requestEpoch = await getAdmissionEpoch(signal)
  const path = `/conversations/${encodeURIComponent(conversationId)}/admissions`
  const body = JSON.stringify({ ...request, epoch: requestEpoch })
  const post = () => fetchUrl(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal })
  let response: Response
  try { response = await post() } catch (error) {
    if (signal.aborted) throw error
    // Never mint a new command when an acknowledgement is lost.
    const lookup = await fetchUrl(`${path}/${encodeURIComponent(String(request.operationId))}`, { signal, cache: 'no-store' })
    if (lookup.ok) response = lookup
    else if (lookup.status === 404) response = await post()
    else throw new Error('Could not reconcile the command. Keep this draft and reload before sending again.')
  }
  const receipt = await response.json()
  if (receipt.code === 'epoch_mismatch') resetAdmissionEpoch()
  if (!response.ok || receipt.status !== 'accepted') throw Object.assign(new Error(receipt.error || 'Command outcome is uncertain after host restart; reconcile before sending again.'), { code: receipt.code, fullAccess: receipt.fullAccess })
  if (receipt.conversationId !== conversationId || receipt.operationId !== request.operationId || typeof receipt.streamId !== 'string') throw new Error('Invalid admission receipt')
  return receipt
}
async function fetchUrl(path: string, init: RequestInit): Promise<Response> { return fetch(await buildLocalApiUrl(path), init) }
