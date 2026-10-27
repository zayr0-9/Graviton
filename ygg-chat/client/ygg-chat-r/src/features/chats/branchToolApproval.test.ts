import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: () => null, setItem: () => undefined } })
})
import { branchModelKey } from './branchModelSelection'
import { loadBranchToolApprovalDrafts, resolveAnchoredToolApproval, resolveBranchToolApproval, resolveComposerToolApproval, saveBranchToolApprovalDrafts } from './branchToolApproval'
import chatReducer, { chatSliceActions } from './chatSlice'
import { projectServerEvent } from './sseProjection'

function state() {
  const initial = chatReducer(undefined, { type: '@@init' })
  return { ...initial, toolAutoApprove: false, branchToolApprovalDrafts: {}, conversation: {
    ...initial.conversation, currentConversationId: 'c', currentLineageId: 'a', currentPath: ['root', 'a'],
    messages: [
      { id: 'root', conversation_id: 'c', meta: { toolAutoApprove: false } },
      { id: 'a', conversation_id: 'c', parent_id: 'root', meta: { toolAutoApprove: true } },
      { id: 'b', conversation_id: 'c', parent_id: 'root', meta: JSON.stringify({ toolAutoApprove: false }) },
    ] as any,
  } }
}
afterEach(() => vi.unstubAllGlobals())

it('restores per-branch policy from persisted history without changing the host fallback', () => {
  const chat = state()
  expect(resolveBranchToolApproval(chat)).toBe(true)
  expect(resolveBranchToolApproval(chat, ['root', 'b'], 'c', 'b')).toBe(false)
  expect(resolveBranchToolApproval(chat, [], 'other', null)).toBe(false)
  chat.branchToolApprovalDrafts = { [branchModelKey('c', 'lineage:a')]: false } as any
  expect(resolveBranchToolApproval(chat)).toBe(false)
  expect(resolveBranchToolApproval(chat, ['root', 'a'], 'c', 'fork')).toBe(true)
})

it('projects background Allow all to the owner, survives draft reload and does not steal selection', () => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  let chat = state()
  chat.conversation.currentLineageId = 'b'
  chat.conversation.currentPath = ['root', 'b']
  for (const action of projectServerEvent({ type: 'tool_approval_changed', streamId: 'run-a', conversationId: 'c', lineageId: 'a', enabled: true,
    message: { ...chat.conversation.messages[1], meta: { toolAutoApprove: true } } }, { streamId: 'run-a', conversationId: 'c' })) {
    chat = chatReducer(chat, action as any) as typeof chat
  }
  expect(chat.conversation.currentPath).toEqual(['root', 'b'])
  expect(resolveBranchToolApproval(chat)).toBe(false)
  expect(resolveBranchToolApproval(chat, ['root', 'a', 'next'], 'c', 'a')).toBe(true)
  expect(chat.toolAutoApprove).toBe(false)
  chat = { ...chat, branchToolApprovalDrafts: loadBranchToolApprovalDrafts() as any }
  expect(resolveBranchToolApproval(chat, [], 'c', 'a')).toBe(true)
})

it('keeps composer toggles branch-scoped and branch editor choices local until sent', () => {
  let chat = chatReducer(state(), chatSliceActions.toolAutoApproveToggled())
  expect(resolveBranchToolApproval(chat)).toBe(false)
  expect(resolveBranchToolApproval(chat, ['root', 'b'], 'c', 'b')).toBe(false)
  expect(chat.toolAutoApprove).toBe(false)
  chat = { ...chat, composition: { ...chat.composition, editingBranch: true } }
  chat = chatReducer(chat, chatSliceActions.toolAutoApproveToggled())
  expect(chat.composition.branchEditModes?.toolAutoApprove).toBe(true)
  expect(resolveBranchToolApproval(chat)).toBe(false)
})

it('round trips explicit Ask and Allow all and rejects malformed stored values', () => {
  let stored = ''
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value } })
  saveBranchToolApprovalDrafts({ a: true, b: false })
  expect(loadBranchToolApprovalDrafts()).toEqual({ a: true, b: false })
  stored = '{"a":true,"b":"true"}'
  expect(loadBranchToolApprovalDrafts()).toEqual({ a: true })
  for (const value of ['null', '[]', '{broken']) {
    stored = value
    expect(loadBranchToolApprovalDrafts()).toEqual({})
  }
})

it('historical forks and edits do not inherit later grants or the source lineage draft', () => {
  const chat = state()
  chat.branchToolApprovalDrafts = { [branchModelKey('c', 'lineage:a')]: true } as any
  expect(resolveAnchoredToolApproval(chat, 'root', 'c')).toBe(false)
  chat.composition = { ...chat.composition, editingBranch: true, branchEditMessageId: 'a' }
  expect(resolveComposerToolApproval(chat)).toBe(false)
})

it('fresh summary handoffs use the host default until explicitly selected, without changing source approval', () => {
  let chat = state()
  chat.providerState = { ...chat.providerState, currentProvider: 'Claude Code', providers: [{ name: 'Claude Code' }] as any }
  chat.conversation.messages.push({ id: 'summary', conversation_id: 'c', parent_id: 'a', role: 'assistant', content: 'committed',
    meta: { kind: 'compaction_summary', state: 'committed', toolAutoApprove: true } } as any)
  chat.conversation.currentPath = ['root', 'a', 'summary']
  chat.branchToolApprovalDrafts = { [branchModelKey('c', 'lineage:a')]: true } as any
  expect(resolveComposerToolApproval(chat)).toBe(false)
  chat = chatReducer(chat, chatSliceActions.toolAutoApproveToggled()) as typeof chat
  expect(resolveComposerToolApproval(chat)).toBe(true)
  expect(resolveBranchToolApproval(chat)).toBe(true)
  expect(chat.branchToolApprovalDrafts[branchModelKey('c', 'handoff:summary')]).toBe(true)
  expect(chat.branchToolApprovalDrafts[branchModelKey('c', 'lineage:a')]).toBe(true)
  const next = { ...chat, composition: { ...chat.composition, editingBranch: true, branchEditMessageId: 'summary' } }
  expect(resolveComposerToolApproval(next)).toBe(false)
})
