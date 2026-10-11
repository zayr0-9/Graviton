import './__testSupport__/localStorageShim'
import { describe, expect, it } from 'vitest'
import reducer, { chatSliceActions as actions } from './chatSlice'
import { applyStreamProjectionPolicy, normalizeServerMessage, projectServerEvent } from './sseProjection'

const ctx = { streamId: 's1', conversationId: 'c1' }
const row = (id: string, parent: string | null, mode?: 'plan' | 'execute') => normalizeServerMessage({
  id, parent_id: parent, conversation_id: 'c1', role: mode ? 'user' : 'assistant', content: '',
  ...(mode ? { meta: { kind: 'operation_mode_change', mode } } : {}),
})
const setup = () => {
  const state = reducer(undefined, { type: 'init' })
  return { ...state, conversation: { ...state.conversation, currentConversationId: 'c1', messages: [row('a1', null)], currentPath: ['a1'] } }
}

describe('operation mode notifications', () => {
  it('adds the durable user row without changing the triggering user message', () => {
    let state = setup()
    state = reducer(state, actions.operationModeChangeRequested({ conversationId: 'c1', requestId: 'r1', mode: 'execute', streamId: 's1' }))
    const events = projectServerEvent({ type: 'operation_mode_changed', message: row('n1', 'a1', 'execute'), mode: 'execute', streamId: 's1' }, ctx)
    expect(events.map(event => event.type)).toEqual([actions.messageAdded.type, actions.operationModeNotificationReceived.type])
    for (const action of events) state = reducer(state, action)
    expect(state.conversation.currentPath).toEqual(['a1', 'n1'])
    expect(state.conversation.messages[0].children_ids).toEqual(['n1'])
    expect(state.operationMode).toBe('execute')
    expect(state.operationModeChanges.c1).toBeUndefined()
    // HTTP acknowledgement arriving after SSE must not recreate a pending switch.
    state = reducer(state, actions.operationModeChangeAccepted({ conversationId: 'c1', requestId: 'r1', mode: 'execute' }))
    expect(state.operationModeChanges.c1).toBeUndefined()
  })

  it('does not move the selected branch for another branch notification', () => {
    let state = setup()
    state = reducer(state, actions.messageAdded(row('a2', null)))
    for (const action of projectServerEvent({ type: 'operation_mode_changed', message: row('n2', 'a2', 'execute'), mode: 'execute' }, ctx)) state = reducer(state, action)
    expect(state.conversation.currentPath).toEqual(['a1'])
    expect(state.operationMode).toBe('plan')
  })

  it('keeps a final mode notification selected when the earlier assistant completes', () => {
    let state = setup()
    for (const action of projectServerEvent({ type: 'operation_mode_changed', message: row('n1', 'a1', 'plan'), mode: 'plan' }, ctx)) state = reducer(state, action)
    state = reducer(state, actions.messageBranchCreated({ newMessage: row('a1', null) }))
    state = reducer(state, actions.streamCompleted({ streamId: 's1', messageId: 'a1' }))
    expect(state.conversation.currentPath).toEqual(['a1', 'n1'])
  })
})

describe('pending operation mode requests', () => {
  it('ignores stale HTTP acknowledgements and failures', () => {
    let state = setup()
    state = reducer(state, actions.operationModeChangeRequested({ conversationId: 'c1', requestId: 'new', mode: 'execute' }))
    state = reducer(state, actions.operationModeChangeAccepted({ conversationId: 'c1', requestId: 'old', mode: 'plan' }))
    state = reducer(state, actions.operationModeChangeFailed({ conversationId: 'c1', requestId: 'old' }))
    expect(state.operationModeChanges.c1).toMatchObject({ requestId: 'new', status: 'requesting', mode: 'execute' })
  })
})

describe('Full access notification ordering', () => {
  const access = (id: string, parent: string) => normalizeServerMessage({
    id, parent_id: parent, conversation_id: 'c1', role: 'user',
    meta: { kind: 'full_access_change', requestId: 'toggle-1' },
  })
  it('shows user input then notice before any assistant output, retaining the original trigger', () => {
    let state = setup()
    state = reducer(state, actions.sendingStarted({ streamId: 's1', conversationId: 'c1' }))
    const user = normalizeServerMessage({ ...row('a1', null), role: 'user', content: 'new input' })
    for (const action of projectServerEvent({ type: 'user_message_persisted', message: user }, ctx)) state = reducer(state, action)
    for (const action of projectServerEvent({ type: 'user_message_persisted', message: access('n1', 'a1') }, ctx)) state = reducer(state, action)
    expect(state.conversation.currentPath).toEqual(['a1', 'n1'])
    expect(state.streaming.byId.s1.triggerUserMessageId).toBe('a1')
    expect(state.streaming.byId.s1.currentBranchAnchorMessageId).toBe('n1')
    // Replay/reconciliation must not rewind the selected settings tail.
    state = reducer(state, actions.messageBranchCreated({ newMessage: row('a1', null) }))
    expect(state.conversation.currentPath).toEqual(['a1', 'n1'])
    for (const action of projectServerEvent({ type: 'operation_mode_changed', message: row('mode', 'n1', 'execute'), mode: 'execute' }, ctx)) state = reducer(state, action)
    expect(state.conversation.currentPath).toEqual(['a1', 'n1', 'mode'])
  })
  it('does not steal navigation for a background branch or parallel pane', () => {
    for (const parallel of [false, true]) {
      let state = setup()
      const parentId = parallel ? 'a1' : 'a2'
      state = reducer(state, actions.messageAdded(row('a2', null)))
      for (const projected of projectServerEvent({ type: 'user_message_persisted', message: access('n2', parentId) }, ctx)) {
        const action = parallel ? applyStreamProjectionPolicy(projected, { streamId: 's1', streamType: 'branch', updatePath: false }) : projected
        state = reducer(state, action)
      }
      expect(state.conversation.currentPath).toEqual(['a1'])
    }
  })
})
