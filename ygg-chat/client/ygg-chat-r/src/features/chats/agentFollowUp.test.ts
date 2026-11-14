import './__testSupport__/localStorageShim'
import { configureStore } from '@reduxjs/toolkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import reducer, { runningAgentsUiActions as actions } from '../ui/runningAgentsUiSlice'
import { emptyFollowUpDraft, findFollowUpKey, followUpCapacity } from '../ui/agentFollowUpState'
import type { AgentForkGroup, AgentStreamListItem } from '../../hooks/useRunningAgentStreams'

const transport = vi.hoisted(() => ({ send: vi.fn(), epoch: vi.fn(async () => 'epoch') }))
vi.mock('./runAdmissionClient', () => ({ getAdmissionEpoch: transport.epoch }))
vi.mock('./chatActions', async () => {
  const { createAsyncThunk } = await import('@reduxjs/toolkit')
  return { enqueueUserMessage: createAsyncThunk('test/queue', async (params: any, { rejectWithValue }) => {
    const result = await transport.send(params)
    return result.failure ? rejectWithValue(result.failure) : result
  }) }
})
import { followUpTarget, submitAgentFollowUp } from './agentFollowUp'

const run = (id: string, overrides: Partial<AgentStreamListItem> = {}) => ({
  streamId: id, streamType: 'branch', conversationId: 'background', status: 'active', hasError: false, ...overrides,
}) as AgentStreamListItem
const fork = (item = run('s')): AgentForkGroup => ({ key: 'fork', displayName: 'fork', lineageId: 'l',
  activeStreams: item.status === 'active' ? [item] : [], completedStreams: item.status === 'active' ? [] : [item], representative: item, hasError: false })
const setup = () => {
  const foreground = { conversation: { currentConversationId: 'foreground', currentPath: ['a'] }, composition: { input: { content: 'untouched' }, imageDrafts: ['image'] } }
  const store = configureStore({ reducer: { runningAgentsUi: reducer, chat: (state = foreground) => state } })
  store.dispatch(actions.followUpChanged({ key: 'fork', content: 'instruction', streamIds: ['s'] }))
  return store
}
afterEach(() => vi.clearAllMocks())

describe('agent follow-up controller', () => {
  it('captures only background text and leaves foreground state untouched', async () => {
    const store = setup()
    const before = store.getState().chat
    transport.send.mockResolvedValue({ streamId: 'next', restarted: true })
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'background', streamId: 's',
      content: 'instruction', includeGlobalComposerContext: false, updatePath: false, preparedTextSubmission: { epoch: 'epoch', fullAccess: false } }))
    expect(store.getState().chat).toBe(before)
    expect(store.getState().runningAgentsUi.followUps.fork).toMatchObject({ content: '', status: 'accepted', acceptedStreamId: 'next' })
  })

  it('locks duplicate surfaces and preserves text typed during acceptance', async () => {
    const store = setup()
    let finish!: (value: any) => void
    transport.send.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = store.dispatch(submitAgentFollowUp(fork()) as any)
    await Promise.resolve()
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    store.dispatch(actions.followUpChanged({ key: 'fork', content: 'new draft', streamIds: ['s'] }))
    finish({ streamId: 's' })
    await pending
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(store.getState().runningAgentsUi.followUps.fork.content).toBe('new draft')
  })

  it('retries unknown delivery with the exact captured payload despite edits and representative changes', async () => {
    const store = setup()
    transport.send.mockResolvedValueOnce({ failure: { message: 'unknown', uncertain: true } }).mockResolvedValueOnce({ streamId: 'next' })
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    const first = transport.send.mock.calls[0][0]
    store.dispatch(actions.followUpChanged({ key: 'fork', content: 'later text', streamIds: ['s', 'next'] }))
    await store.dispatch(submitAgentFollowUp(fork(run('next'))) as any)
    expect(transport.send.mock.calls[1][0]).toEqual(first)
    expect(store.getState().runningAgentsUi.followUps.fork.content).toBe('later text')
  })

  it('preserves rejected text and confirms a policy mismatch with a new identity', async () => {
    const store = setup()
    transport.send.mockResolvedValueOnce({ failure: { message: 'policy mismatch', uncertain: false, code: 'configuration_mismatch', fullAccess: true } })
      .mockResolvedValueOnce({ streamId: 's' })
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    expect(store.getState().runningAgentsUi.followUps.fork).toMatchObject({ content: 'instruction', status: 'rejected', policy: true })
    await store.dispatch(submitAgentFollowUp(fork(), true) as any)
    expect(transport.send.mock.calls[1][0].requestId).not.toBe(transport.send.mock.calls[0][0].requestId)
    expect(transport.send.mock.calls[1][0].preparedTextSubmission.fullAccess).toBe(true)
  })

  it('rejects ambiguous, failed and non-main targets; accepts a completed candidate', () => {
    expect(followUpTarget(fork(run('s', { streamType: 'subagent' }))).reason).toBeTruthy()
    expect(followUpTarget(fork(run('s', { status: 'error' }))).reason).toBeTruthy()
    expect(followUpTarget({ ...fork(), activeStreams: [run('s'), run('other')] }).reason).toBeTruthy()
    expect(followUpTarget(fork(run('s', { status: 'completed' }))).reason).toBeUndefined()
  })
})

describe('agent draft retention', () => {
  it('survives hide/collapse/reset and lineage confirmation without key migration races', () => {
    const store = setup()
    store.dispatch(actions.forkHidden({ key: 'fork', streamIds: ['s'] }))
    store.dispatch(actions.forkCollapsed('fork'))
    store.dispatch(actions.sizeReset())
    expect(findFollowUpKey(store.getState().runningAgentsUi.followUps, 'confirmed-lineage', ['s'])).toBe('fork')
    expect(store.getState().runningAgentsUi.followUps.fork.content).toBe('instruction')
  })
  it('bounds drafts without evicting nonempty text', () => {
    const drafts = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${i}`, { ...emptyFollowUpDraft(), content: 'keep' }]))
    expect(followUpCapacity(drafts, 'new', 'text')).toBe(false)
    expect(followUpCapacity(drafts, '0', 'edit')).toBe(true)
    expect(followUpCapacity({}, 'new', 'x'.repeat(200001))).toBe(false)
  })
})

describe('review regressions', () => {
  it('invalidates a policy acknowledgement when the user edits the rejected text', async () => {
    const store = setup()
    transport.send.mockResolvedValue({ failure: { message: 'policy', uncertain: false, code: 'configuration_mismatch', fullAccess: true } })
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    store.dispatch(actions.followUpChanged({ key: 'fork', content: 'replacement', streamIds: ['s'] }))
    expect(store.getState().runningAgentsUi.followUps.fork).toMatchObject({ content: 'replacement', status: 'idle', policy: undefined, attempt: undefined })
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    expect(transport.send.mock.calls[1][0].content).toBe('replacement')
  })
  it('clears accepted status on typing and reclaims empty accepted records', async () => {
    const store = setup()
    transport.send.mockResolvedValue({ streamId: 's' })
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    store.dispatch(actions.followUpChanged({ key: 'fork', content: 'next', streamIds: ['s'] }))
    expect(store.getState().runningAgentsUi.followUps.fork.status).toBe('idle')
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    store.dispatch(actions.followUpChanged({ key: 'other', content: 'draft', streamIds: ['other'] }))
    expect(store.getState().runningAgentsUi.followUps.fork).toBeUndefined()
  })
  it('preserves both merged unresolved drafts and blocks a second intent until uncertainty is reconciled', async () => {
    const store = setup()
    store.dispatch(actions.followUpChanged({ key: 'other', content: 'second draft', streamIds: ['other'] }))
    transport.send.mockResolvedValue({ failure: { uncertain: true, message: 'unknown' } })
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    const merged = { ...fork(), key: 'confirmed', activeStreams: [run('s')], completedStreams: [run('other', { status: 'completed' })] }
    await store.dispatch(submitAgentFollowUp(merged, false, 'other') as any)
    expect(transport.send).toHaveBeenCalledTimes(1)
    expect(store.getState().runningAgentsUi.followUps.other.content).toBe('second draft')
    transport.send.mockResolvedValue({ streamId: 's' })
    await store.dispatch(submitAgentFollowUp(merged, false, 'fork') as any)
    await store.dispatch(submitAgentFollowUp(merged, false, 'other') as any)
    expect(transport.send.mock.calls[2][0].content).toBe('second draft')
  })
  it('keeps text on epoch fetch failure without an uncertain submitted attempt', async () => {
    const store = setup()
    transport.epoch.mockRejectedValueOnce(new Error('offline'))
    await store.dispatch(submitAgentFollowUp(fork()) as any)
    expect(store.getState().runningAgentsUi.followUps.fork).toMatchObject({ status: 'rejected', content: 'instruction' })
    expect(store.getState().runningAgentsUi.followUps.fork.attempt).toBeUndefined()
    expect(transport.send).not.toHaveBeenCalled()
  })
})
