import { normalizeHostExecutionPreferences, type HostExecutionSnapshot, type HostExecutionPreferences } from '../../../../shared/hostExecutionPreferences'
import { isNativeShell } from '../platform/clientCapabilities'
import { buildLocalApiUrl } from '../utils/api'
let snapshot: HostExecutionSnapshot | undefined
let problemNotice: HTMLElement | undefined
function showProblem(message: string): void {
  if (typeof document === 'undefined') return
  problemNotice ??= document.createElement('div')
  problemNotice.setAttribute('role', 'alert')
  problemNotice.textContent = message
  problemNotice.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:10000;padding:12px;background:#fff3cd;color:#332701'
  if (!problemNotice.isConnected) document.body.append(problemNotice)
}
export const getHostExecutionPreferences = () => snapshot?.values
export const getHostExecutionRevision = (domain?: keyof HostExecutionPreferences) => domain ? snapshot?.revisions?.[domain] ?? snapshot?.revision : snapshot?.revision
export const HOST_EXECUTION_CHANGED = 'graviton:execution-preferences-changed'
function install(value: HostExecutionSnapshot) {
  if (!value.hostId || !value.epoch || !Number.isSafeInteger(value.revision)) throw new Error('Invalid host settings response')
  if (snapshot && (snapshot.hostId !== value.hostId || snapshot.epoch !== value.epoch)) {
    showProblem('The Graviton host changed. Reload before updating settings; unsaved edits remain in this window.')
    throw new Error('Host changed. Reload before updating settings.')
  }
  if (value.repairNeeded) showProblem(value.repairNeeded)
  if (snapshot && snapshot.revision >= value.revision) return
  snapshot = { ...value, values: normalizeHostExecutionPreferences(value.values) }
  window.dispatchEvent(new CustomEvent(HOST_EXECUTION_CHANGED, { detail: snapshot.values }))
}
export async function initializeHostExecutionPreferences(): Promise<void> {
  if (isNativeShell) {
    const keys = ['chat:autoCompactionEnabled', 'chat:defaultToolAutoApprove', 'chat:longTermMemoryContextEnabled', 'chat:contextDirectories', 'ygg_plan_mode_response_settings', 'ygg_provider_settings', 'ygg_tool_settings', 'ygg_subagent_tool_settings', 'ygg_operation_mode_prompt_settings', 'ygg_tool_execution_settings']
    install(await window.electronAPI!.executionPreferences.importLegacy(Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]))))
  } else await refreshHostExecutionPreferences()
}
export async function refreshHostExecutionPreferences(): Promise<void> {
  if (isNativeShell) { install(await window.electronAPI!.executionPreferences.read()); return }
  const response = await fetch(await buildLocalApiUrl('/host/execution-preferences'), { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('Host settings unavailable')
  install(await response.json())
}
export async function saveHostExecutionPreference(patch: Partial<HostExecutionPreferences>, expectedRevision = snapshot?.revision): Promise<void> {
  if (!snapshot) throw new Error('Host settings not ready')
  if (snapshot.repairNeeded) throw new Error(snapshot.repairNeeded)
  const keys = Object.keys(patch) as Array<keyof HostExecutionPreferences>
  const expectedRevisions = snapshot.revisions ? Object.fromEntries(keys.map(key => [key,
    (key === 'provider' || key === 'subagent' || key === 'modePrompts' || key === 'toolTimeouts') ? expectedRevision : snapshot!.revisions![key]])) : undefined
  const request = { hostId: snapshot.hostId, epoch: snapshot.epoch, expectedRevision, expectedRevisions, patch }
  if (isNativeShell) { install(await window.electronAPI!.executionPreferences.save(request)); return }
  const response = await fetch(await buildLocalApiUrl('/host/execution-preferences'), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || 'Could not save host settings')
  install(value)
}
