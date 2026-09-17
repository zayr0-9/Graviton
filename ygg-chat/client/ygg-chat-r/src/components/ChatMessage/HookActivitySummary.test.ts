import { describe, expect, it } from 'vitest'
import { summarizeHookRuns } from './HookActivityCard'
import type { HookRunRecord } from '../../features/chats/chatTypes'

const status = (value: HookRunRecord['status']) => ({ status: value } as HookRunRecord)

describe('summarizeHookRuns', () => {
  it('prioritizes failures, then active runs, then total count', () => {
    expect(summarizeHookRuns([status('succeeded'), status('failed')])).toBe('1 failed')
    expect(summarizeHookRuns([status('running'), status('scheduled')])).toBe('2 running')
    expect(summarizeHookRuns([status('succeeded'), status('skipped')])).toBe('2 ran')
  })
})
