import './__testSupport__/localStorageShim'
import { describe, expect, it } from 'vitest'
import reducer, { chatSliceActions as actions } from './chatSlice'
import { applyStreamProjectionPolicy, projectServerEvent, type ServerStreamEvent } from './sseProjection'

const row = (id: string, parent_id: string | null, role = 'user', meta?: object) => ({
  id, parent_id, role, meta, conversation_id: 'c', content: id, children_ids: [], created_at: '2026-01-01',
})
function setup(policy: 'sender' | 'observer' | 'parallel' = 'sender') {
  let state = reducer(undefined, { type: 'init' })
  const dispatch = (action: any) => { state = reducer(state, action) }
  dispatch(actions.conversationSet('c'))
  dispatch(actions.messageAdded(row('before', null, 'assistant') as any))
  dispatch(actions.conversationPathSet(['before']))
  dispatch(actions.sendingStarted({ streamId: 's', conversationId: 'c', updatePath: policy === 'sender',
    followSelectedTip: policy === 'observer', selectionRevision: state.selection.revision }))
  const emit = (event: Record<string, unknown>) => {
    for (const action of projectServerEvent(event as unknown as ServerStreamEvent, { streamId: 's', conversationId: 'c' })) {
      dispatch(applyStreamProjectionPolicy(action, { streamId: 's', streamType: 'primary', updatePath: policy === 'sender' }))
    }
  }
  const summary = row('summary', 'instruction', 'assistant', { kind: 'compaction_summary', state: 'committed' })
  const compact = () => {
    emit({ type: 'started', parentId: 'before', lineageId: 'l' })
    emit({ type: 'user_message_persisted', message: row('instruction', 'before', 'user', { kind: 'compaction_instruction' }) })
    emit({ type: 'assistant_message_persisted', message: summary })
    emit({ type: 'context_compaction', status: 'completed', summaryMessage: summary })
    emit({ type: 'context_injection_persisted', message: row('restored-context', 'summary', 'user', { kind: 'context_injection', reason: 'compact' }) })
  }
  return { get: () => state, dispatch, emit, summary, compact }
}

describe('post-compaction branch head', () => {
  it.each(['sender', 'observer'] as const)('keeps the restored context as the next-send parent for %s without reload', policy => {
    const h = setup(policy)
    h.compact()
    expect(h.get().conversation.currentPath.at(-1)).toBe('restored-context')
    h.emit({ type: 'complete', message: h.summary, lineageId: 'l' })
    expect(h.get().conversation.currentPath).toEqual(['before', 'instruction', 'summary', 'restored-context'])
    const stream = h.get().streaming.byId.s
    expect(stream.triggerUserMessageId).toBe('instruction')
    expect(stream.currentBranchAnchorMessageId).toBe('restored-context')
  })
  it('does not move a parallel pane into the primary selection', () => {
    const h = setup('parallel'); h.compact(); h.emit({ type: 'complete', message: h.summary, lineageId: 'l' })
    expect(h.get().conversation.currentPath).toEqual(['before'])
  })
  it('does not pull an observer off a selected sibling', () => {
    const h = setup('observer')
    h.dispatch(actions.messageAdded(row('sibling', 'before', 'assistant') as any))
    h.dispatch(actions.conversationPathSet(['before', 'sibling']))
    h.compact(); h.emit({ type: 'complete', message: h.summary, lineageId: 'l' })
    expect(h.get().conversation.currentPath).toEqual(['before', 'sibling'])
    expect(h.get().conversation.messages.some(message => message.id === 'restored-context')).toBe(true)
  })
  it('projects automatic compaction controls without replacing the original trigger or rewinding on replay', () => {
    const h = setup('observer'); h.compact()
    h.emit({ type: 'compaction_control_persisted', message: row('resume', 'restored-context', 'user', { kind: 'compaction_resume' }) })
    h.emit({ type: 'assistant_message_persisted', message: h.summary })
    h.emit({ type: 'complete', message: h.summary, lineageId: 'l' })
    expect(h.get().conversation.currentPath.at(-1)).toBe('resume')
    expect(h.get().streaming.byId.s.triggerUserMessageId).toBe('instruction')
  })
})

it('does not preserve an ordinary user follow-up as a synthetic continuation tail', () => {
  const h = setup(); h.compact()
  h.emit({ type: 'queued_user_message_persisted', message: row('real-user', 'restored-context') })
  h.emit({ type: 'complete', message: h.summary, lineageId: 'l' })
  // Only control/context tails get no-rewind treatment, not arbitrary user input.
  expect(h.get().streaming.byId.s.finalMessageId).toBe('summary')
})
