import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
})
import reducer, { chatSliceActions as actions } from './chatSlice'
import { projectServerEvent, applyStreamProjectionPolicy } from './sseProjection'
import { selectDisplayMessagesFor } from './chatSelectors'
import { canFollowSelectedTip } from './followSelectedTip'
import type { Message } from './chatTypes'

const row = (id: string, parent_id: string | null, role = 'assistant') => ({ id, parent_id, role, conversation_id: 'c', content: '', children_ids: [], created_at: '2026-01-01', content_blocks: [] }) as unknown as Message
function setup(follow = true) {
  let state = reducer(undefined, { type: 'init' })
  const dispatch = (action: any) => { state = reducer(state, action) }
  dispatch(actions.conversationSet('c'))
  dispatch(actions.messageAdded(row('u', null, 'user')))
  dispatch(actions.conversationPathSet(['u']))
  dispatch(actions.sendingStarted({ streamId: 's', conversationId: 'c', streamType: 'branch', updatePath: false, selectionRevision: -1, followSelectedTip: follow }))
  const emit = (event: any) => {
    for (const action of projectServerEvent(event, { streamId: 's', conversationId: 'c' }))
      dispatch(applyStreamProjectionPolicy(action, { streamId: 's', streamType: 'branch', updatePath: false }))
  }
  return { get: () => state, dispatch, emit }
}
describe('passive selected-tip following', () => {
  it('retains three persisted turns through generation resets and terminal completion', () => {
    const h = setup()
    let parent = 'u'
    for (let turn = 1; turn <= 3; turn++) {
      const message = row(`a${turn}`, parent)
      h.emit({ type: 'assistant_message_persisted', message })
      h.emit({ type: 'tool_loop', status: 'turn_started', turn: turn + 1 })
      parent = message.id
    }
    h.emit({ type: 'complete', message: row('final', parent) })
    expect(h.get().conversation.currentPath).toEqual(['u', 'a1', 'a2', 'a3', 'final'])
    expect(selectDisplayMessagesFor(h.get().conversation.messages, h.get().conversation.currentPath)).toHaveLength(5)
    expect(h.get().streaming.byId.s.selectionRevision).toBe(-1)
  })
  it('stops when navigation selects a sibling and does not reclaim it on terminal', () => {
    const h = setup()
    h.emit({ type: 'assistant_message_persisted', message: row('a', 'u') })
    h.dispatch(actions.messageAdded(row('sibling', 'u')))
    h.dispatch(actions.conversationPathSet(['u', 'sibling']))
    h.emit({ type: 'assistant_message_persisted', message: row('b', 'a') })
    h.emit({ type: 'complete', message: row('final', 'b') })
    expect(h.get().conversation.currentPath).toEqual(['u', 'sibling'])
    expect(h.get().conversation.messages.map(message => message.id)).toEqual(expect.arrayContaining(['b', 'final']))
  })
  it('keeps explicit parallel updatePath:false isolated', () => {
    const h = setup(false)
    h.emit({ type: 'assistant_message_persisted', message: row('a', 'u') })
    h.emit({ type: 'complete', message: row('final', 'a') })
    expect(h.get().conversation.currentPath).toEqual(['u'])
  })
  it('preserves follow policy during authoritative rebootstrap', () => {
    const h = setup()
    h.dispatch(actions.streamBootstrapReset({ streamId: 's', conversationId: 'c' }))
    expect(h.get().streaming.byId.s).toMatchObject({ followSelectedTip: true, updatePath: false, selectionRevision: -1 })
    h.emit({ type: 'assistant_message_persisted', message: row('a', 'u') })
    h.dispatch(actions.streamBootstrapReconciled({ streamId: 's', messageIds: ['a'] }))
    expect(h.get().conversation.currentPath).toEqual(['u', 'a'])
  })
  it('follows queued and mode rows only when adjacent', () => {
    const h = setup()
    h.emit({ type: 'queued_user_message_persisted', message: row('queued', 'u', 'user') })
    h.emit({ type: 'operation_mode_changed', mode: 'execute', message: row('mode', 'queued', 'user') })
    h.emit({ type: 'assistant_message_persisted', message: row('a', 'mode') })
    expect(h.get().conversation.currentPath).toEqual(['u', 'queued', 'mode', 'a'])
  })
  it('rejects missing ancestors, cycles and a confirmed foreign lineage', () => {
    const h = setup()
    h.emit({ type: 'assistant_message_persisted', message: row('missing', 'absent') })
    h.emit({ type: 'assistant_message_persisted', message: row('cycle', 'cycle') })
    expect(h.get().conversation.currentPath).toEqual(['u'])
    h.dispatch(actions.lineageSelected({ conversationId: 'c', lineageId: 'chosen', path: ['u'], focus: null }))
    h.emit({ type: 'started', parentId: 'u', lineageId: 'other', conversationId: 'c' })
    h.emit({ type: 'assistant_message_persisted', message: row('foreign', 'u') })
    expect(h.get().conversation.currentPath).toEqual(['u'])
  })
})

it('fails closed on a cross-conversation ancestor even when the tip is its direct parent', () => {
  const h = setup()
  h.dispatch(actions.messageAdded(row('target', 'u')))
  const state = structuredClone(h.get())
  state.conversation.messages.find(message => message.id === 'u')!.conversation_id = 'other'
  expect(canFollowSelectedTip(state, state.streaming.byId.s, 'target')).toBe(false)
})

it('never rewinds a restored-context tail during compact bootstrap reconciliation', () => {
  const h = setup()
  const summary = row('summary', 'u')
  const context = { ...row('context', 'summary', 'user'), meta: { kind: 'context_injection' } }
  for (const message of [summary, context]) h.dispatch(actions.messageAdded(message))
  h.dispatch(actions.conversationPathSet(['u', 'summary', 'context']))
  h.dispatch(actions.streamBootstrapReset({ streamId: 's', conversationId: 'c' }))
  h.dispatch(actions.streamBootstrapReconciled({ streamId: 's', messageIds: ['u', 'summary', 'context', 'summary'] }))
  expect(h.get().conversation.currentPath).toEqual(['u', 'summary', 'context'])
})
it.each([true, false])('only a selection-owning sender may recover an empty view (observer=%s)', observer => {
  const h = setup(observer)
  h.dispatch(actions.conversationPathSet([]))
  h.dispatch(actions.sendingStarted({ streamId: 's', conversationId: 'c', updatePath: !observer,
    followSelectedTip: observer }))
  h.dispatch(actions.messageAdded(row('a', 'u')))
  h.dispatch(actions.streamBootstrapReset({ streamId: 's', conversationId: 'c' }))
  h.dispatch(actions.streamBootstrapReconciled({ streamId: 's', messageIds: ['u', 'a'] }))
  expect(h.get().conversation.currentPath).toEqual(observer ? [] : ['u', 'a'])
})
