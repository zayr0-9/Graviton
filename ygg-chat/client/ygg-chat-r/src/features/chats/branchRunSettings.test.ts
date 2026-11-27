import './__testSupport__/localStorageShim'
import { describe, expect, it } from 'vitest'
import chatReducer, { chatSliceActions as chat } from './chatSlice'
import { composerFullAccessTarget, resolveComposerFullAccess, resolveLineageFullAccess } from './branchFullAccess'
import { loadClaudeUltracodeDrafts, resolveAnchoredUltracode, resolveBranchUltracode, resolveEditUltracode } from './branchUltracode'
import type { Message } from './chatTypes'

const row = (id: string, parent: string | null, lineage: string, meta: Record<string, unknown> = {}) => ({
  id, conversation_id: 'c', parent_id: parent, lineage_id: lineage, role: 'assistant', meta,
} as Message)
const select = (lineageId: string | null, path: string[], conversationId = 'c') =>
  chat.lineageSelected({ conversationId, lineageId, path, focus: path.at(-1) ?? null })
function setup() {
  const state = chatReducer(undefined, { type: 'init' })
  return {
    ...state,
    providerState: { ...state.providerState, currentProvider: 'lmstudio' },
    branchFullAccessChoices: {}, claudeUltracodeDrafts: {},
    conversation: { ...state.conversation, currentConversationId: 'c', currentLineageId: 'a', currentPath: ['root', 'a'],
      messages: [row('root', null, 'a'), row('a', 'root', 'a'), row('b', 'root', 'b'), row('tip', 'a', 'a')] },
  }
}

describe('Full Access', () => {
  it('restores the opt-in on the same lineage after navigation, not on siblings, other chats, or a fresh renderer', () => {
    let state = chatReducer(setup(), chat.branchFullAccessSelected(true))
    const granted = resolveComposerFullAccess(state)
    expect(granted).toEqual({ fullAccess: true, fullAccessNotificationId: expect.any(String) })
    state = chatReducer(state, select('b', ['root', 'b']))
    expect(resolveComposerFullAccess(state).fullAccess).toBe(false)
    state = chatReducer(state, select('a', ['root', 'b']))
    expect(resolveComposerFullAccess(state).fullAccess).toBe(false)
    state = chatReducer(state, select('a', [], 'other'))
    expect(resolveComposerFullAccess(state).fullAccess).toBe(false)
    state = chatReducer(state, chat.stateReset())
    state = chatReducer(state, select('a', ['root', 'a', 'tip']))
    expect(resolveComposerFullAccess(state)).toEqual(granted)
    const fresh = chatReducer(setup(), select('a', ['root', 'a']))
    expect(resolveComposerFullAccess(fresh).fullAccess).toBe(false)
  })

  it('keeps edit opt-ins local until a new lineage starts; cancel does not change the source', () => {
    let state = chatReducer(setup(), chat.branchFullAccessSelected(true))
    const source = resolveComposerFullAccess(state)
    state = chatReducer(state, chat.editingBranchSet(true))
    state = chatReducer(state, chat.branchEditMessageSelected('a'))
    expect(resolveComposerFullAccess(state).fullAccess).toBe(false)
    state = chatReducer(state, chat.branchFullAccessSelected(true))
    const edit = resolveComposerFullAccess(state)
    expect(edit.fullAccessNotificationId).not.toBe(source.fullAccessNotificationId)
    state = chatReducer(state, chat.editingBranchSet(false))
    expect(resolveComposerFullAccess(state)).toEqual(source)
    state = chatReducer(state, chat.branchFullAccessRunStarted({ conversationId: 'c', lineageId: 'fork', sourceKey: null, requestId: edit.fullAccessNotificationId! }))
    state = chatReducer(state, chat.branchFullAccessNoticePersisted(edit.fullAccessNotificationId!))
    expect(resolveLineageFullAccess(state, 'c', 'fork')).toEqual({ fullAccess: true })
    expect(resolveComposerFullAccess(state)).toEqual(source)
  })

  it('moves an empty-branch opt-in only once and a stale replay cannot undo a newer choice', () => {
    let state = chatReducer(setup(), select(null, [], 'empty'))
    state = chatReducer(state, chat.branchFullAccessSelected(true))
    const committed = chat.branchFullAccessRunStarted({ conversationId: 'empty', lineageId: 'new',
      sourceKey: composerFullAccessTarget(state), requestId: resolveComposerFullAccess(state).fullAccessNotificationId! })
    state = chatReducer(state, committed)
    expect(resolveComposerFullAccess(state).fullAccess).toBe(false)
    state = chatReducer(state, select('new', [], 'empty'))
    state = chatReducer(state, chat.branchFullAccessSelected(false))
    state = chatReducer(state, chat.branchFullAccessSelected(true))
    const latest = resolveComposerFullAccess(state)
    state = chatReducer(state, committed)
    state = chatReducer(state, chat.branchFullAccessNoticePersisted(committed.payload.requestId))
    expect(resolveComposerFullAccess(state)).toEqual(latest)
  })
})

describe('Ultracode', () => {
  it('keeps lineage drafts (including off) separate and preserves them in storage', () => {
    let state = chatReducer(setup(), chat.claudeUltracodeSet(true))
    state = chatReducer(state, select('b', ['root', 'b']))
    expect(resolveBranchUltracode(state)).toBe(false)
    state = chatReducer(state, chat.claudeUltracodeSet(false))
    expect(loadClaudeUltracodeDrafts()).toEqual(state.claudeUltracodeDrafts)
    state = chatReducer(state, select(null, ['root', 'a', 'tip']))
    expect(resolveBranchUltracode(state)).toBe(true)
    state = chatReducer(state, select('b', ['root', 'b']))
    expect(resolveBranchUltracode(state)).toBe(false)
  })

  it('reads recorded values at the cut without borrowing a newer lineage draft or another editor', () => {
    const base = setup()
    base.conversation.messages = [row('root', null, 'a'), row('a', 'root', 'a', { claudeUltracode: true }),
      row('b', 'root', 'b'), row('tip', 'a', 'a', { claudeUltracode: false })]
    let state = chatReducer(base, select('a', ['root', 'a', 'tip']))
    expect(resolveBranchUltracode(state)).toBe(false)
    state = chatReducer(state, chat.claudeUltracodeSet(true))
    expect(resolveBranchUltracode(state)).toBe(true)
    expect(resolveAnchoredUltracode(state, 'c', 'tip')).toBe(false)
    expect(resolveAnchoredUltracode(state, 'other', 'a')).toBe(false)
    state = chatReducer(state, chat.editingBranchSet(true))
    state = chatReducer(state, chat.branchEditMessageSelected('a'))
    state = chatReducer(state, chat.claudeUltracodeSet(false))
    expect(resolveEditUltracode(state, 'c', 'a')).toBe(false)
    expect(resolveEditUltracode(state, 'c', 'tip')).toBe(false)
    state = chatReducer(state, chat.editingBranchSet(false))
    expect(resolveEditUltracode(state, 'c', 'a')).toBe(true)
  })
})
