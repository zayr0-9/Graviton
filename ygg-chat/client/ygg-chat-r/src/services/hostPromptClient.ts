import { refreshHostExecutionPreferences } from './hostExecutionClient'
import { validateHostPrompts, type HostPromptSnapshot } from '../../../../shared/hostPrompts'
import { isNativeShell } from '../platform/clientCapabilities'
import { buildLocalApiUrl } from '../utils/api'
export const HOST_PROMPTS_CHANGED = 'ygg-user-system-prompts-storage-change'
let snapshot: HostPromptSnapshot | undefined
export const readCachedHostPrompts = () => snapshot
let lastProblem = ''
function notifyPromptProblem(message: string): void {
  if (lastProblem === message) return
  lastProblem = message
  const notice = document.createElement('div')
  notice.setAttribute('role', 'alert')
  notice.textContent = message
  notice.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:10000;padding:12px;background:#fff3cd;color:#332701'
  document.body.append(notice)
}
function install(value: HostPromptSnapshot): void {
  if (value.schema !== 1 || !value.hostId || !value.epoch || !Number.isSafeInteger(value.revision)) throw new Error('Unsupported host prompt response')
  const prompts = validateHostPrompts(value.prompts)
  if (snapshot && (value.hostId !== snapshot.hostId || value.epoch !== snapshot.epoch)) {
    notifyPromptProblem('The Graviton host changed. Reload to reconcile saved prompts; unsaved edits remain in this window.')
    throw new Error('The host changed. Reload to reconcile prompts.')
  }
  if (snapshot && value.revision <= snapshot.revision) return
  snapshot = { schema: 1, revision: value.revision, prompts, hostId: value.hostId, epoch: value.epoch, repairNeeded: value.repairNeeded }
  if (value.repairNeeded) notifyPromptProblem(value.repairNeeded)
  window.dispatchEvent(new CustomEvent(HOST_PROMPTS_CHANGED))
}
export async function refreshHostPrompts(signal?: AbortSignal): Promise<void> {
  if (isNativeShell) { install(await window.electronAPI!.prompts.read()); return }
  const response = await fetch(await buildLocalApiUrl('/host/prompts'), { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Host prompts unavailable')
  install(await response.json())
}
export async function initializeHostPrompts(): Promise<void> {
  if (isNativeShell) {
    // Pass the raw value to the host so an already-completed migration never
    // parses obsolete data. Invalid legacy data is retained for explicit recovery.
    install(await window.electronAPI!.prompts.importLegacy(localStorage.getItem('ygg_user_system_prompts')))
  } else await refreshHostPrompts(AbortSignal.timeout(10000))
}
export async function saveHostPrompts(prompts: HostPromptSnapshot['prompts']): Promise<void> {
  if (!snapshot) throw new Error('Host prompts are not ready')
  const revision = snapshot.revision
  if (isNativeShell) {
    const result = await window.electronAPI!.prompts.save(revision, prompts, snapshot)
    if (!result.snapshot) throw new Error(result.error || 'Could not save prompts')
    install(result.snapshot)
    return
  }
  const url = await buildLocalApiUrl('/host/prompts')
  const options = { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: revision, prompts, hostId: snapshot.hostId, epoch: snapshot.epoch }) }
  let response: Response
  try { response = await fetch(url, options) }
  catch { response = await fetch(url, options) } // Same replacement and revision, never a new prompt ID.
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Could not save prompts')
  install(result)
}
export function startHostPromptRefresh(): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = async () => {
    await Promise.allSettled([refreshHostPrompts(controller.signal), refreshHostExecutionPreferences()]) // One unavailable domain must not stop refresh of the other.
    if (!controller.signal.aborted) timer = setTimeout(poll, 3000)
  }
  timer = setTimeout(poll, 3000)
  return () => { controller.abort(); clearTimeout(timer) }
}
