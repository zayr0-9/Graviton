import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
})
import reducer, { chatSliceActions as actions } from './chatSlice'
import { projectServerEvent, applyStreamProjectionPolicy } from './sseProjection'
import { selectCurrentViewStreamFor } from './chatSelectors'
import { chatSelectionCancelled, chatSelectionCommitted, chatSelectionRequested, resolveLocalChatSelection } from './chatSelection'
import type { Message } from './chatTypes'

// Navigating away from Chat and back while a run streams must never strand the run:
// rows persisted while selection is unsettled are deferred, then caught up on the same view.
let clock = 0
const row = (id: string, parent_id: string | null, role = 'assistant') => ({
  id, parent_id, role, conversation_id: 'c', content: '', children_ids: [], content_blocks: [],
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
}) as unknown as Message

function setup({ lineage = false }: { lineage?: boolean } = {}) {
  let state = reducer(undefined, { type: 'init' })
  const dispatch = (action: any) => { state = reducer(state, action) }
  let requests = 0
  const request = (conversationId = 'c') => {
    const requestId = `r${++requests}`
    dispatch(chatSelectionRequested({ requestId, target: { kind: 'conversation', conversationId }, source: 'route' }))
    return requestId
  }
  // Mirrors the controller: a conversation-only route resolves against the retained view.
  const commit = (requestId: string, override?: { path: string[] }) => {
    const c = state.conversation
    const resolved = override
      ? { conversationId: c.currentConversationId!, lineageId: null, path: override.path, focus: null }
      : resolveLocalChatSelection(state.selection.target!, c.messages,
        { conversationId: c.currentConversationId!, lineageId: c.currentLineageId, path: c.currentPath, focus: c.focusedChatMessageId })!
    dispatch(chatSelectionCommitted({ ...resolved, requestId }))
  }
  const away = () => dispatch(chatSelectionCancelled())

  commit(request())
  dispatch(actions.messageAdded(row('u', null, 'user')))
  dispatch(actions.conversationPathSet(['u']))
  dispatch(actions.sendingStarted({
    streamId: 's', conversationId: 'c', streamType: 'primary', updatePath: true,
    selectionRevision: state.selection.revision, lineage: { rootMessageId: 'u', ...(lineage ? { lineageId: 'L' } : {}) },
  }))
  const emit = (event: any) => {
    for (const action of projectServerEvent(event, { streamId: 's', conversationId: 'c' }))
      dispatch(applyStreamProjectionPolicy(action, { streamId: 's', streamType: 'primary', updatePath: true }))
  }
  const persist = (id: string, parent: string) => emit({ type: 'assistant_message_persisted', message: row(id, parent) })
  const path = () => state.conversation.currentPath
  const viewStreamId = () => selectCurrentViewStreamFor(state.streaming, {
    conversationId: state.conversation.currentConversationId, lineageId: state.conversation.currentLineageId, path: state.conversation.currentPath,
  })?.id ?? null
  emit({ type: 'started', parentId: 'u', conversationId: 'c', ...(lineage ? { lineageId: 'L' } : {}) })
  return { get: () => state, dispatch, request, commit, away, persist, emit, path, viewStreamId }
}

describe('deferred selection advances across navigation', () => {
  it.each([false, true])('keeps view ownership through Settings -> Back (lineage=%s)', lineage => {
    const h = setup({ lineage })
    h.persist('a1', 'u')
    h.away()
    h.persist('a2', 'a1')
    h.commit(h.request())
    h.persist('a3', 'a2')
    expect(h.path()).toEqual(['u', 'a1', 'a2', 'a3'])
    expect(h.viewStreamId()).toBe('s')
  })

  it('catches up a row deferred by a transaction that a second route request superseded', () => {
    const h = setup()
    h.persist('a1', 'u')
    h.away()
    h.request()
    h.persist('a2', 'a1')
    h.commit(h.request())
    h.persist('a3', 'a2')
    expect(h.path()).toEqual(['u', 'a1', 'a2', 'a3'])
  })

  it('catches up when the user leaves again before the snapshot settles', () => {
    const h = setup()
    h.persist('a1', 'u')
    h.away()
    h.request()
    h.persist('a2', 'a1')
    h.away()
    h.persist('a3', 'a2')
    h.commit(h.request())
    h.persist('a4', 'a3')
    expect(h.path()).toEqual(['u', 'a1', 'a2', 'a3', 'a4'])
    expect(h.get().streaming.byId.s.selectionBlocked).toBeUndefined()
  })

  it('catches up rows deferred while a snapshot failure left selection in error', () => {
    const h = setup()
    h.persist('a1', 'u')
    const failed = h.request()
    h.dispatch({ type: 'chat/selectionFailed', payload: { requestId: failed, error: 'offline' } })
    h.persist('a2', 'a1')
    h.commit(h.request())
    expect(h.path()).toEqual(['u', 'a1', 'a2'])
  })

  it('never pulls a different selected view back to the deferred stream', () => {
    const h = setup()
    h.persist('a1', 'u')
    h.dispatch(actions.messageAdded(row('sibling', 'u')))
    const r = h.request()
    h.persist('a2', 'a1')
    h.commit(r, { path: ['u', 'sibling'] })
    h.away()
    h.persist('a3', 'a2')
    expect(h.path()).toEqual(['u', 'sibling'])
    expect(h.get().streaming.byId.s.selectionBlocked).toBeUndefined()
  })

  it('discards deferrals when another conversation is selected', () => {
    const h = setup()
    h.persist('a1', 'u')
    h.request()
    h.persist('a2', 'a1')
    expect(h.get().streaming.byId.s.selectionBlocked).toBe(true)
    h.request('other')
    expect(h.get().streaming.byId.s.selectionBlocked).toBeUndefined()
  })

  it('still loses ownership when a different view is committed', () => {
    const h = setup()
    h.persist('a1', 'u')
    h.dispatch(actions.messageAdded(row('sibling', 'u')))
    h.commit(h.request(), { path: ['u', 'sibling'] })
    h.commit(h.request(), { path: ['u', 'a1'] })
    h.persist('a2', 'a1')
    // Re-selecting the run's branch by hand is a new view; the tip anchor still lets it follow.
    expect(h.path()).toEqual(['u', 'a1', 'a2'])
    h.commit(h.request(), { path: ['u', 'sibling'] })
    h.persist('a3', 'a2')
    expect(h.path()).toEqual(['u', 'sibling'])
  })
})
