import './__testSupport__/localStorageShim'
import { describe, expect, it } from 'vitest'
import reducer, { chatSliceActions as actions } from './chatSlice'
import { applyStreamProjectionPolicy, normalizeServerMessage, projectServerEvent } from './sseProjection'

const row = (id: string, parent: string | null, role = 'assistant') => normalizeServerMessage({ id, parent_id: parent, role, conversation_id: 'c', content: id })
const ctx = { streamId: 's', conversationId: 'c' }
const setup = () => {
  const initial = reducer(undefined, { type: 'init' })
  return { ...initial, conversation: { ...initial.conversation, currentConversationId: 'c', messages: [row('a', null)], currentPath: ['a'] } }
}

describe('message queue projection', () => {
  it('ignores older HTTP snapshots after a delivered SSE update', () => {
    let state = setup()
    const snapshot = { streamId: 's', conversationId: 'c', lineageId: 'l', revision: 3, items: [{ requestId: 'q', content: 'new', attachmentCount: 0, status: 'delivered' as const }] }
    state = reducer(state, actions.messageQueueUpdated(snapshot))
    state = reducer(state, actions.messageQueueUpdated({ ...snapshot, revision: 1, items: [{ ...snapshot.items[0], status: 'queued' }] }))
    expect(state.messageQueues.s.items[0].status).toBe('delivered')
  })

  it('persists first-class user rows without replacing the stream trigger', () => {
    let state = setup()
    state = reducer(state, actions.sendingStarted({ streamId: 's', conversationId: 'c', lineage: { originMessageId: 'original' } }))
    for (const action of projectServerEvent({ type: 'queued_user_message_persisted', streamId: 's', requestId: 'q', lineageId: 'l', message: row('u2', 'a', 'user') }, ctx)) state = reducer(state, action)
    expect(state.conversation.currentPath).toEqual(['a', 'u2'])
    expect(state.streaming.byId.s.triggerUserMessageId).toBe('original')
    expect(state.streaming.byId.s.currentBranchAnchorMessageId).toBe('u2')
  })

  it('does not navigate the primary pane for a parallel submission', () => {
    let state = setup()
    for (const action of projectServerEvent({ type: 'queued_user_message_persisted', streamId: 's', requestId: 'q', lineageId: 'l', message: row('u2', 'a', 'user') }, ctx)) {
      state = reducer(state, applyStreamProjectionPolicy(action, { streamId: 's', streamType: 'branch', updatePath: false }))
    }
    expect(state.conversation.currentPath).toEqual(['a'])
    expect(state.conversation.messages.find(row => row.id === 'u2')?.role).toBe('user')
  })

  it('does not erase follow-up image drafts when an earlier generation completes', () => {
    let state = setup()
    state = reducer(state, actions.sendingStarted({ streamId: 's', conversationId: 'c' }))
    state = reducer(state, actions.imageDraftsAppended([{ dataUrl: 'data:image/png;base64,AA', name: 'new.png', type: 'image/png', size: 2 }]))
    state = reducer(state, actions.sendingCompleted({ streamId: 's' }))
    expect(state.composition.imageDrafts).toHaveLength(1)
  })
})
