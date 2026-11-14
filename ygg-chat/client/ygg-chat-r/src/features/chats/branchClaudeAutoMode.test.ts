import { describe, expect, it } from 'vitest'
import { branchModelKey } from './branchModelSelection'
import { resolveAnchoredClaudeAutoMode, resolveBranchClaudeAutoMode } from './branchClaudeAutoMode'
import type { ChatState } from './chatTypes'

const row = (id: string, parent: string | null, meta: Record<string, unknown> | null) =>
  ({ id, conversation_id: 'c1', parent_id: parent, meta: meta ? JSON.stringify(meta) : null })
const chat = (path: string[], drafts: Record<string, boolean> = {}, launchDefault = false) => ({
  conversation: { messages: rows, currentPath: path, currentConversationId: 'c1' },
  claudeAutoModeDrafts: drafts,
  claudeAutoMode: launchDefault,
}) as unknown as ChatState

// u1 → a1 (Ask, plan mode) → a2 (plan approved: auto) → u2 → a3; b1 is a sibling branch with no record.
const rows = [
  row('u1', null, { operationMode: 'execute', claudePlanMode: true }),
  row('a1', 'u1', { operationMode: 'execute', claudePlanMode: true, claudePermissionMode: 'default' }),
  row('a2', 'a1', { operationMode: 'execute', claudePlanMode: false, claudePermissionMode: 'auto' }),
  row('u2', 'a2', { operationMode: 'execute' }),
  row('a3', 'u2', { operationMode: 'execute', claudePermissionMode: 'default' }),
  row('b1', 'u1', { operationMode: 'execute' }),
]

describe('resolveBranchClaudeAutoMode', () => {
  it('keeps the branch in auto mode after an approved plan', () => {
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'a1']))).toBe(false)
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'a1', 'a2']))).toBe(true)
    // A running turn's user row records nothing; the row above it decides.
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'a1', 'a2', 'u2']))).toBe(true)
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'a1', 'a2', 'u2', 'a3']))).toBe(false)
  })

  it('lets a composer choice at the tip win, and newer rows win over older choices', () => {
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'a1', 'a2'], { [branchModelKey('c1', 'a2')]: false }))).toBe(false)
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'a1', 'a2'], { [branchModelKey('c1', 'u1')]: false }))).toBe(true)
  })

  it('falls back to the launch default on a branch with no record or choice', () => {
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'b1'], {}, true))).toBe(true)
    expect(resolveBranchClaudeAutoMode(chat(['u1', 'b1'], {}, false))).toBe(false)
    expect(resolveBranchClaudeAutoMode(chat([], {}, true))).toBe(true)
  })

  it('resolves fork and edit sends at their cut', () => {
    expect(resolveAnchoredClaudeAutoMode(chat(['u1', 'b1']), 'a2', 'c1')).toBe(true)
    expect(resolveAnchoredClaudeAutoMode(chat(['u1', 'a1', 'a2']), 'a1', 'c1')).toBe(false)
  })
})
