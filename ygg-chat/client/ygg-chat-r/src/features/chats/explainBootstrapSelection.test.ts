import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
})
import reducer, { chatSliceActions as actions } from './chatSlice'
import { projectServerEvent } from './sseProjection'
import { chatSelectionCommitted, chatSelectionRequested } from './chatSelection'
import type { Message } from './chatTypes'

// Explain selection is an admitted `send` with isBranch. A fast host (Claude) persists the
// fork's user row before the initiator attaches, so the row arrives in the bootstrap while
// navigation is gated. The initiator must still switch to its fork; observers must not.
let clock = 0
const row = (id: string, parent_id: string | null, role = 'assistant', lineage_id = 'L0') => ({
  id, parent_id, role, lineage_id, conversation_id: 'c', content: '', children_ids: [], content_blocks: [],
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
}) as unknown as Message

function setup() {
  let state = reducer(undefined, { type: 'init' })
  const dispatch = (action: any) => { state = reducer(state, action) }
  let requests = 0
  const commit = (path: string[], lineageId: string | null = 'L0') => {
    const requestId = `r${++requests}`
    dispatch(chatSelectionRequested({ requestId, target: { kind: 'conversation', conversationId: 'c' }, source: 'route' }))
    dispatch(chatSelectionCommitted({ conversationId: 'c', lineageId, path, focus: null, requestId }))
  }
  const request = () => {
    const requestId = `r${++requests}`
    dispatch(chatSelectionRequested({ requestId, target: { kind: 'conversation', conversationId: 'c' }, source: 'route' }))
    return requestId
  }
  for (const message of [row('u1', null, 'user'), row('a1', 'u1'), row('u2', 'a1', 'user'), row('a2', 'u2')]) dispatch(actions.messageAdded(message))
  commit(['u1', 'a1', 'u2', 'a2'])

  /** What the Explain handler + sendMessage thunk dispatch before admission. */
  const startExplain = (streamId: string, opts: { followSelectedTip?: boolean; selectionRevision?: number } = {}) =>
    dispatch(actions.sendingStarted({
      streamId, conversationId: 'c', streamType: 'primary', updatePath: true, followSelectedTip: opts.followSelectedTip,
      selectionRevision: opts.selectionRevision ?? state.selection.revision, lineage: { lineageId: 'L0', rootMessageId: 'a1' },
    }))
  const emit = (streamId: string, event: any) => {
    for (const action of projectServerEvent(event, { streamId, conversationId: 'c' })) dispatch(action)
  }
  /** Mirrors mainChatClient's bootstrap install: the fork's user row is already persisted. */
  const bootstrap = (streamId: string, extra: Message[] = []) => {
    const user = row('e1', 'a1', 'user', 'L1')
    const persisted = [user, ...extra]
    dispatch(actions.streamBootstrapReset({ streamId, conversationId: 'c' }))
    for (const message of persisted) dispatch(actions.messageAdded(message))
    emit(streamId, { type: 'started', parentId: 'e1', conversationId: 'c', lineageId: 'L1' })
    emit(streamId, { type: 'user_message_persisted', message: user, lineageId: 'L1' })
    for (const message of extra) emit(streamId, { type: 'assistant_message_persisted', message, lineageId: 'L1' })
    dispatch(actions.streamBootstrapReconciled({ streamId, messageIds: persisted.map(message => String(message.id)) }))
  }
  return {
    get: () => state, dispatch, commit, request, startExplain, emit, bootstrap,
    path: () => state.conversation.currentPath, lineage: () => state.conversation.currentLineageId,
  }
}

describe('Explain fork persisted before the initiator attaches', () => {
  it('switches the initiator to its fork from a historical message', () => {
    const h = setup()
    h.startExplain('x')
    h.bootstrap('x')
    expect(h.path()).toEqual(['u1', 'a1', 'e1'])
    expect(h.lineage()).toBe('L1')

    // Live rows after attach keep extending the fork, and completion stays there.
    h.emit('x', { type: 'assistant_message_persisted', message: row('f1', 'e1', 'assistant', 'L1'), lineageId: 'L1' })
    h.emit('x', { type: 'complete', message: row('f2', 'f1', 'assistant', 'L1'), lineageId: 'L1' })
    expect(h.path()).toEqual(['u1', 'a1', 'e1', 'f1', 'f2'])
    expect(h.lineage()).toBe('L1')
  })

  it('selects the deepest fork row already in the bootstrap', () => {
    const h = setup()
    h.startExplain('x')
    h.bootstrap('x', [row('f1', 'e1', 'assistant', 'L1')])
    expect(h.path()).toEqual(['u1', 'a1', 'e1', 'f1'])
  })

  it('does not move a passive observer or a reloaded reattach onto the fork', () => {
    const h = setup()
    h.startExplain('obs', { followSelectedTip: true, selectionRevision: -1 })
    h.bootstrap('obs')
    expect(h.path()).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(h.lineage()).toBe('L0')
  })

  it('does not pull back an initiator that selected another view before attaching', () => {
    const h = setup()
    h.startExplain('x')
    h.commit(['u1', 'a1', 'u2'], null)
    h.bootstrap('x')
    expect(h.path()).toEqual(['u1', 'a1', 'u2'])
  })

  it('catches up a fork deferred by pending navigation on the same view', () => {
    const h = setup()
    h.startExplain('x')
    const requestId = h.request()
    h.bootstrap('x')
    expect(h.path()).toEqual(['u1', 'a1', 'u2', 'a2'])
    h.dispatch(chatSelectionCommitted({ conversationId: 'c', lineageId: 'L0', path: ['u1', 'a1', 'u2', 'a2'], focus: null, requestId }))
    expect(h.path()).toEqual(['u1', 'a1', 'e1'])
    expect(h.lineage()).toBe('L1')
  })
})
