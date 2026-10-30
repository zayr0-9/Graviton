import { describe, expect, it } from 'vitest'
import { claudeModeNoticesByMessageId } from './claudeModeNotices'

const user = (id: string, operationMode?: 'plan' | 'execute') => ({ id, role: 'user', meta: operationMode ? { operationMode } : null })
const assistant = (id: string) => ({ id, role: 'assistant', meta: null })
const notice = (id: string, mode: 'plan' | 'execute') => ({ id, role: 'user', meta: JSON.stringify({ kind: 'operation_mode_change', mode }) })

describe('claudeModeNoticesByMessageId', () => {
  it('announces the first Claude turn and each change, not repeats', () => {
    const notices = claudeModeNoticesByMessageId([
      user('u1', 'plan'), assistant('a1'), user('u2', 'plan'), assistant('a2'),
      user('u3', 'execute'), assistant('a3'), user('u4', 'execute'), user('u5', 'plan'),
    ])
    expect([...notices]).toEqual([
      ['u1', { mode: 'plan', initial: true }],
      ['u3', { mode: 'execute', initial: false }],
      ['u5', { mode: 'plan', initial: false }],
    ])
  })

  it('continues from persisted notification rows earlier on the branch', () => {
    const notices = claudeModeNoticesByMessageId([user('u0'), notice('n0', 'execute'), assistant('a0'), user('u1', 'execute'), user('u2', 'plan')])
    expect([...notices]).toEqual([['u2', { mode: 'plan', initial: false }]])
  })

  it('ignores rows without a recorded Claude mode', () => {
    expect(claudeModeNoticesByMessageId([user('u1'), assistant('a1'), { id: 'x', role: 'assistant', meta: { operationMode: 'plan' } }]).size).toBe(0)
  })
})
