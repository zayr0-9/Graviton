import type { HookRunRecord } from '../../features/chats/chatTypes'

export const ACTIVE_HOOK_RUN_STATUSES = new Set<HookRunRecord['status']>(['scheduled', 'running'])

export function hasActiveHookRuns(runs: HookRunRecord[]): boolean {
  return runs.some(run => ACTIVE_HOOK_RUN_STATUSES.has(run.status))
}

/**
 * Hook-only message updates must invalidate Chat's cached render rows. The timestamp
 * changes for every persisted lifecycle transition, while the id/status pair keeps the
 * signature useful for older records that lack a distinct update timestamp.
 */
export function getHookRunsRenderSignature(runs?: HookRunRecord[]): string {
  if (!runs?.length) return ''
  return runs.map(run => `${run.id}:${run.status}:${run.updatedAt}`).join(',')
}

export function didHookRunsSettle(wasActive: boolean, runs: HookRunRecord[]): boolean {
  return wasActive && !hasActiveHookRuns(runs)
}

export function areHookRunSetsEqual(left: HookRunRecord[], right: HookRunRecord[]): boolean {
  return getHookRunsRenderSignature(left) === getHookRunsRenderSignature(right)
}
