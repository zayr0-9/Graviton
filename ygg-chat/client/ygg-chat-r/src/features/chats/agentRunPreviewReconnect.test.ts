import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
})
vi.mock('../../utils/api', () => ({ buildLocalApiUrl: async (p: string) => `http://local/api${p}`, FORCE_LOGOUT_EVENT: 'force-logout' }))
vi.mock('../../platform/clientCapabilities', () => ({ isHostClient: false }))
vi.mock('../../helpers/serverLoopSettings', () => ({ isResumableRunsEnabled: () => true }))
import chatReducer, { chatSliceActions as chat } from './chatSlice'
import previewReducer, { agentRunPreviewActions as preview, agentRunPreviewMiddleware } from './agentRunPreviewSlice'
import { runServerReattach } from './mainChatClient'
import { buildAgentPreviewRows } from '../../components/RunningAgentsFloatingButton/agentPreviewContent'
import { RunSnapshotProjector } from '../../../server/headlessServer/services/runSnapshotProjector'

const row = (id: string, parent_id: string | null, content: string, role = 'assistant') => ({
  id, parent_id, content, role, conversation_id: 'c', revision: 1, children_ids: [], created_at: '2026-01-01',
  content_blocks: [{ type: 'text', index: 0, content }],
})
const setup = () => configureStore({
  reducer: { chat: chatReducer, agentRunPreviews: previewReducer, conversations: () => ({ items: [] }) },
  middleware: getDefault => getDefault().prepend(agentRunPreviewMiddleware),
})
const response = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } })
const texts = (store: ReturnType<typeof setup>) => buildAgentPreviewRows(store.getState().agentRunPreviews.byStreamId.s)
  .flatMap(row => row.blocks).filter(block => block.type === 'text').map(block => block.content)

describe('pill compact reconnect capture', () => {
  it.each([false, true])('recovers all persisted offline turns, not the selected Chat path (background=%s)', async background => {
    const store = setup()
    store.dispatch(chat.conversationSet(background ? 'other' : 'c'))
    store.dispatch(chat.sendingStarted({ streamId: 's', conversationId: 'c', updatePath: true }))
    if (!background) {
      store.dispatch(chat.messageAdded(row('u', null, 'Request', 'user') as any))
      store.dispatch(chat.conversationPathSet(['u']))
    }
    const projector = new RunSnapshotProjector()
    const rows = [row('u', null, 'Request', 'user')]
    const events: any[] = [{ type: 'started', parentId: 'u', conversationId: 'c' },
      { type: 'user_message_persisted', message: rows[0] }]
    for (let i = 1; i <= 3; i++) {
      events.push({ type: 'tool_loop', status: 'turn_started', turn: i })
      rows.push(row(`m${i}`, rows.at(-1)!.id, `Offline turn ${i}`))
      events.push({ type: 'assistant_message_persisted', message: rows.at(-1) })
    }
    events.push({ type: 'tool_loop', status: 'turn_started', turn: 4 }, { type: 'chunk', part: 'text', delta: 'Current tail' })
    for (const event of events) projector.apply(event)
    const snapshot = projector.snapshot({ epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 50,
      persisted: rows.map(row => ({ id: row.id, revision: 1, row })), pendingDecisions: [] })
    const fetchMock = vi.fn().mockImplementation(() => response([{ type: 'bootstrap', snapshot },
      { type: 'complete', seq: 51, message: row('final', 'm3', 'Current tail') }]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', signal: new AbortController().signal },
        { dispatch: store.dispatch as any, getState: store.getState })
      expect(texts(store)).toEqual(['Request', 'Offline turn 1', 'Offline turn 2', 'Offline turn 3', 'Current tail'])
      expect(store.getState().chat.conversation.currentPath).toEqual(background ? [] : ['u', 'm1', 'm2', 'm3', 'final'])
    } finally { vi.unstubAllGlobals() }
  })

  it('replaces only the current transient tail on repeated bootstrap, without overwriting an earlier persisted turn', async () => {
    const store = setup()
    store.dispatch(chat.conversationSet('c'))
    store.dispatch(chat.sendingStarted({ streamId: 's', conversationId: 'c' }))
    const user = row('u', null, 'Request', 'user')
    const first = row('m1', 'u', 'First turn')
    const snapshot = (tail: string) => ({ kind: 'main', schema: 1, epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 50,
      persisted: [user, first].map(row => ({ id: row.id, revision: 1, row })), pendingDecisions: [], queueRevision: 0,
      events: [{ type: 'user_message_persisted', message: user }, { type: 'assistant_message_persisted', message: first },
        { type: 'tool_loop', status: 'turn_started', turn: 2 }, { type: 'chunk', part: 'text', delta: tail }] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([{ type: 'bootstrap', snapshot: snapshot('First live copy') },
      { type: 'bootstrap', snapshot: snapshot('Authoritative live copy') },
      { type: 'complete', seq: 51, message: row('final', 'm1', 'Authoritative live copy') }])))
    try {
      await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', signal: new AbortController().signal },
        { dispatch: store.dispatch as any, getState: store.getState })
      expect(texts(store)).toEqual(['Request', 'First turn', 'Authoritative live copy'])
    } finally { vi.unstubAllGlobals() }
  })
})

it('uses exact snapshot tool blocks, removes deleted rows and accepts later result enrichment', async () => {
  const store = setup()
  store.dispatch(chat.sendingStarted({ streamId: 's', conversationId: 'c' }))
  const user = row('u', null, 'Request', 'user')
  const tool = { ...row('tool', 'u', ''), content_blocks: [
    { type: 'tool_use', index: 0, id: 'call', name: 'read_file', input: {} },
    { type: 'tool_result', index: 1, tool_use_id: 'call', content: 'captured result' },
  ] }
  const snapshot = (messages: any[]) => ({ kind: 'main', schema: 1, epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 50,
    persisted: messages.map(row => ({ id: row.id, revision: 1, row })), pendingDecisions: [], queueRevision: 0,
    events: [{ type: 'started', parentId: 'u' }, { type: 'user_message_persisted', message: user },
      { type: 'tool_loop', status: 'turn_started', turn: 3 }] })
  const enriched = { ...tool, revision: 2, content_blocks: [...tool.content_blocks.slice(0, 1),
    { type: 'tool_result', index: 1, tool_use_id: 'call', content: 'enriched result' }] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
    { type: 'bootstrap', snapshot: snapshot([row('deleted', 'u', 'Deleted old turn'), tool, user]) },
    { type: 'bootstrap', snapshot: { ...snapshot([tool, user]), deletedMessageIds: ['deleted'] } },
    { type: 'assistant_message_persisted', seq: 51, message: enriched },
    { type: 'complete', seq: 52, message: row('final', 'tool', 'Answer') },
  ])))
  try {
    await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', signal: new AbortController().signal },
      { dispatch: store.dispatch as any, getState: store.getState })
    const run = store.getState().agentRunPreviews.byStreamId.s
    expect(run.entries.filter(entry => entry.message).map(entry => entry.message!.id)).toEqual(['u', 'tool', 'final'])
    const blocks = buildAgentPreviewRows(run).flatMap(row => row.blocks)
    expect(blocks.filter(block => block.type === 'tool_use')).toHaveLength(1)
    expect(blocks.filter(block => block.type === 'tool_result')).toEqual([expect.objectContaining({ content: 'enriched result' })])
  } finally { vi.unstubAllGlobals() }
})

it('reattaches the live tool turn once and preserves it through its next generation boundary', async () => {
  const store = setup()
  store.dispatch(chat.sendingStarted({ streamId: 's', conversationId: 'c' }))
  const user = row('u', null, 'Request', 'user')
  const tool = { ...row('tool', 'u', ''), content_blocks: [
    { type: 'tool_use', index: 0, id: 'call', name: 'read_file', input: {} },
  ] }
  const snapshot = { kind: 'main', schema: 1, epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 50,
    persisted: [user, tool].map(row => ({ id: row.id, revision: 1, row })), pendingDecisions: [], queueRevision: 0,
    events: [{ type: 'user_message_persisted', message: user }, { type: 'tool_loop', status: 'turn_started', turn: 1 },
      { type: 'chunk', part: 'tool_call', toolCall: { id: 'call', name: 'read_file', arguments: {} } },
      { type: 'assistant_message_persisted', message: tool }] }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([{ type: 'bootstrap', snapshot },
    { type: 'chunk', seq: 51, part: 'tool_result', toolResult: { tool_use_id: 'call', content: 'Late result' } },
    { type: 'tool_loop', seq: 52, status: 'turn_started', turn: 2 },
    { type: 'chunk', seq: 53, part: 'text', delta: 'Next answer' },
    { type: 'complete', seq: 54, message: row('final', 'tool', 'Next answer') },
  ])))
  try {
    await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', signal: new AbortController().signal },
      { dispatch: store.dispatch as any, getState: store.getState })
    const blocks = buildAgentPreviewRows(store.getState().agentRunPreviews.byStreamId.s).flatMap(row => row.blocks)
    expect(blocks.map(block => block.type)).toEqual(['text', 'tool_use', 'tool_result', 'text'])
    expect(blocks[2]).toMatchObject({ content: 'Late result' })
    expect(blocks[3]).toMatchObject({ content: 'Next answer' })
  } finally { vi.unstubAllGlobals() }
})

it('releases a failed bootstrap gate when terminal cleanup arrives', () => {
  const store = setup()
  store.dispatch(chat.sendingStarted({ streamId: 's', conversationId: 'c' }))
  store.dispatch(preview.bootstrapReceived({ streamId: 's', messages: [row('u', null, 'Request', 'user') as any] }))
  store.dispatch(chat.streamBootstrapReset({ streamId: 's', conversationId: 'c' }))
  // An installation failure prevents streamBootstrapReconciled; thunk cleanup
  // must still finish the pill and expose the later classified error chunk.
  store.dispatch(chat.sendingCompleted({ streamId: 's' }))
  store.dispatch(chat.streamChunkReceived({ streamId: 's', chunk: { type: 'error', error: 'Reconnect failed' } }))
  const run = store.getState().agentRunPreviews.byStreamId.s
  expect(run.bootstrapInstalling).toBe(false)
  expect(run.stream.active).toBe(false)
  expect(run.completedAt).toBeTruthy()
  expect(run.stream.error).toBeTruthy()
})
