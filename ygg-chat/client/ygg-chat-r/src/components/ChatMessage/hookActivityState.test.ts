import { describe, expect, it } from 'vitest'
import type { HookRunRecord } from '../../features/chats/chatTypes'
import { areHookRunSetsEqual, didHookRunsSettle, getHookRunsRenderSignature, hasActiveHookRuns } from './hookActivityState'

const run = (id: string, status: HookRunRecord['status'], updatedAt = '2026-01-01T00:00:00.000Z') =>
  ({ id, status, updatedAt } as HookRunRecord)

describe('hook activity state', () => {
  it('changes the render signature when a hook-only lifecycle update arrives', () => {
    const scheduled = getHookRunsRenderSignature([run('run-1', 'scheduled')])
    const completed = getHookRunsRenderSignature([run('run-1', 'succeeded', '2026-01-01T00:00:01.000Z')])

    expect(scheduled).not.toBe(completed)
    expect(areHookRunSetsEqual([run('run-1', 'scheduled')], [run('run-1', 'scheduled')])).toBe(true)
    expect(areHookRunSetsEqual([run('run-1', 'scheduled')], [run('run-1', 'succeeded')])).toBe(false)
  })

  it('detects active runs and the transition to a settled set', () => {
    expect(hasActiveHookRuns([run('run-1', 'running')])).toBe(true)
    expect(hasActiveHookRuns([run('run-1', 'skipped')])).toBe(false)
    expect(didHookRunsSettle(true, [run('run-1', 'succeeded')])).toBe(true)
    expect(didHookRunsSettle(false, [run('run-1', 'succeeded')])).toBe(false)
  })
})
