import './__testSupport__/localStorageShim'
import { describe, expect, it } from 'vitest'
import reducer, { chatSliceActions as chat } from './chatSlice'
import { getCompactionPresentationScope, isCompactionVisibleFor } from './compactionVisibility'
import type { Message } from './chatTypes'
import { AUTO_COMPACTION_NOTE } from './summaryPresentation'

const row = (id: string, parent_id: string | null, extra: Partial<Message> = {}): Message => ({
  id, parent_id, conversation_id: 'c', role: 'assistant', content: id,
  content_plain_text: id, children_ids: [], created_at: '2026-10-09',
  model_name: 'test', partial: false, pastedContext: [], artifacts: [], ...extra,
})
const messages = [row('root', null), row('a', 'root'), row('b', 'root'),
  row('summary', 'a', { role: 'system', note: AUTO_COMPACTION_NOTE }),
  row('sibling-summary', 'a', { role: 'system', note: AUTO_COMPACTION_NOTE }),
  row('other-child', 'a', { role: 'user' }),
  row('mode', 'summary', { role: 'system', meta: { kind: 'operation_mode_change', mode: 'plan' } }),
]
const owner = { conversationId: 'c', parentMessageId: 'a', lineageId: 'lineage-a' }
const view = (path: string[], lineageId: string | null = null, conversationId = 'c') => ({
  conversationId, lineageId, path, messages,
})

describe('compaction branch visibility', () => {
  it('captures ownership at start, hides on a sibling, and shows again on return', () => {
    let state = reducer(undefined, chat.lineageSelected({
      conversationId: 'c', lineageId: 'lineage-a', path: ['root', 'a'], focus: 'a',
    }))
    state = reducer(state, chat.compactingStarted({ conversationId: 'c', parentMessageId: 'a' }))
    expect(state.composition.compactingLineageId).toBe('lineage-a')
    const captured = {
      conversationId: state.composition.compactingConversationId,
      parentMessageId: state.composition.compactingParentMessageId,
      lineageId: state.composition.compactingLineageId,
    }
    expect(isCompactionVisibleFor(captured, view(['root', 'a'], 'lineage-a'))).toBe(true)
    expect(isCompactionVisibleFor(captured, view(['root', 'b'], 'lineage-b'))).toBe(false)
    expect(isCompactionVisibleFor(captured, view(['root', 'a'], 'lineage-a'))).toBe(true)
    state = reducer(state, chat.compactingFinished())
    expect(state.composition.compactingLineageId).toBeNull()
  })

  it('retains only the returned summary for the matching compaction owner', () => {
    let state = reducer(undefined, chat.compactingStarted({ conversationId: 'c', parentMessageId: 'a' }))
    state = reducer(state, chat.compactionSummaryPersisted({
      conversationId: 'c', parentMessageId: 'b', messageId: 'sibling-summary',
    }))
    expect(state.composition.compactionSummaryMessageId).toBeNull()
    state = reducer(state, chat.compactionSummaryPersisted({
      conversationId: 'c', parentMessageId: 'a', messageId: 'summary',
    }))
    state = reducer(state, chat.compactingFinished())
    expect(state.composition.compactionSummaryMessageId).toBe('summary')
    state = reducer(state, chat.compactingStarted({ conversationId: 'c', parentMessageId: 'b' }))
    expect(state.composition.compactionSummaryMessageId).toBeNull()
  })

  it('does not bleed through shared ancestors with different lineage identities', () => {
    expect(isCompactionVisibleFor(owner, view(['root', 'a', 'other-child'], 'lineage-b'))).toBe(false)
  })

  it('uses branch-tip ownership for legacy paths, not ancestor membership', () => {
    const legacyOwner = { ...owner, lineageId: null }
    expect(isCompactionVisibleFor(legacyOwner, view(['root', 'a']))).toBe(true)
    expect(isCompactionVisibleFor(legacyOwner, view(['root', 'b']))).toBe(false)
    expect(isCompactionVisibleFor(legacyOwner, view(['root', 'a', 'other-child']))).toBe(false)
    expect(isCompactionVisibleFor(legacyOwner, view([]))).toBe(false)
  })

  it('keeps completion visible through the summary path update and lineage reset', () => {
    expect(isCompactionVisibleFor({ ...owner, summaryMessageId: 'summary' }, view(['root', 'a', 'summary', 'mode']))).toBe(true)
    expect(isCompactionVisibleFor({ ...owner, summaryMessageId: 'summary' }, view(['root', 'a', 'sibling-summary']))).toBe(false)
    expect(isCompactionVisibleFor(owner, view(['root', 'a', 'sibling-summary']))).toBe(false)
    expect(isCompactionVisibleFor(owner, view(['root', 'b']))).toBe(false)
  })

  it('never matches another conversation or a missing owner', () => {
    expect(isCompactionVisibleFor(owner, view(['root', 'a'], 'lineage-a', 'other'))).toBe(false)
    expect(isCompactionVisibleFor({ ...owner, parentMessageId: null }, view(['root', 'a']))).toBe(false)
  })

  it('does not capture the selected lineage for another conversation or branch', () => {
    const selected = reducer(undefined, chat.lineageSelected({
      conversationId: 'c', lineageId: 'lineage-a', path: ['root', 'a'], focus: 'a',
    }))
    for (const payload of [
      { conversationId: 'other', parentMessageId: 'a' },
      { conversationId: 'c', parentMessageId: 'b' },
    ]) {
      expect(reducer(selected, chat.compactingStarted(payload)).composition.compactingLineageId).toBeNull()
    }
  })
})

describe('compaction completion presentation scope', () => {
  it('isolates idle sibling branches even when neither has a stream ID', () => {
    expect(getCompactionPresentationScope('c', null, ['root', 'a'], messages))
      .not.toBe(getCompactionPresentationScope('c', null, ['root', 'b'], messages))
  })

  it('remains stable when summary and mode markers extend the owning branch', () => {
    expect(getCompactionPresentationScope('c', null, ['root', 'a'], messages, 'summary'))
      .toBe(getCompactionPresentationScope('c', null, ['root', 'a', 'summary', 'mode'], messages, 'summary'))
    expect(getCompactionPresentationScope('c', null, ['root', 'a'], messages, 'summary'))
      .not.toBe(getCompactionPresentationScope('c', null, ['root', 'a', 'sibling-summary'], messages, 'summary'))
  })

  it('keeps an in-loop run stable while summary persistence advances its path', () => {
    expect(getCompactionPresentationScope('c', 'run-a', ['root', 'a'], messages))
      .toBe(getCompactionPresentationScope('c', 'run-a', ['root', 'a', 'summary'], messages))
  })

  it('isolates conversations and stream runs', () => {
    const scope = getCompactionPresentationScope('c', 'run-a', ['root', 'a'], messages)
    expect(scope).not.toBe(getCompactionPresentationScope('other', 'run-a', ['root', 'a'], messages))
    expect(scope).not.toBe(getCompactionPresentationScope('c', 'run-b', ['root', 'a'], messages))
  })
})
