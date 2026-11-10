import { describe, expect, it } from 'vitest'
import { branchModelKey } from './branchModelSelection'
import { resolveBranchPlanMode, withClaudePlanModeDraft } from './branchPlanMode'
import type { ChatState } from './chatTypes'

const row = (id: string, meta: Record<string, unknown> | null) => ({ id, meta: meta ? JSON.stringify(meta) : null })
const chat = (messages: Array<{ id: string; meta: string | null }>, path: string[], drafts: Record<string, boolean> = {}) => ({
  conversation: { messages, currentPath: path, currentConversationId: 'c1' },
  claudePlanModeDrafts: drafts,
}) as unknown as ChatState

// u1 → a1 (plan) → u2 → a2: the plan was approved mid-run, so a2 records it off.
const rows = [
  row('u1', { operationMode: 'plan', claudePlanMode: true }),
  row('a1', { operationMode: 'plan', claudePlanMode: true }),
  row('u2', { operationMode: 'execute', claudePlanMode: true }),
  row('a2', { operationMode: 'execute', claudePlanMode: false }),
  row('b1', { operationMode: 'plan' }),
]

describe('resolveBranchPlanMode', () => {
  it('reads the newest Claude row on the selected branch', () => {
    expect(resolveBranchPlanMode(chat(rows, ['u1', 'a1']))).toBe(true)
    // The plan was approved: the response after it reads as off.
    expect(resolveBranchPlanMode(chat(rows, ['u1', 'a1', 'u2', 'a2']))).toBe(false)
    // A Claude row without the field ran without plan mode.
    expect(resolveBranchPlanMode(chat(rows, ['u1', 'b1']))).toBe(false)
  })

  it('lets a composer choice at the tip win, and newer rows win over older choices', () => {
    const atTip = { [branchModelKey('c1', 'a2')]: true }
    expect(resolveBranchPlanMode(chat(rows, ['u1', 'a1', 'u2', 'a2'], atTip))).toBe(true)
    const older = { [branchModelKey('c1', 'u1')]: false }
    expect(resolveBranchPlanMode(chat(rows, ['u1', 'a1'], older))).toBe(true)
    // Each branch keeps its own choice.
    const onB = { [branchModelKey('c1', 'b1')]: true }
    expect(resolveBranchPlanMode(chat(rows, ['u1', 'b1'], onB))).toBe(true)
    expect(resolveBranchPlanMode(chat(rows, ['u1', 'a1', 'u2', 'a2'], onB))).toBe(false)
  })

  it('uses the empty-branch choice before the first message and is off by default', () => {
    expect(resolveBranchPlanMode(chat([], []))).toBe(false)
    expect(resolveBranchPlanMode(chat([], [], { [branchModelKey('c1', null)]: true }))).toBe(true)
    // Rows from other providers record no Claude mode and are skipped.
    expect(resolveBranchPlanMode(chat([row('x', { modelSelection: { provider: 'openaichatgpt' } })], ['x']))).toBe(false)
  })

  it('keeps the newest choices when the store is full', () => {
    let drafts: Record<string, boolean> = {}
    for (let index = 0; index < 205; index++) drafts = withClaudePlanModeDraft(drafts, `k${index}`, true)
    drafts = withClaudePlanModeDraft(drafts, 'k10', false)
    const keys = Object.keys(drafts)
    expect(keys).toHaveLength(200)
    expect(keys.at(-1)).toBe('k10')
    expect(keys[0]).toBe('k5')
  })
})
