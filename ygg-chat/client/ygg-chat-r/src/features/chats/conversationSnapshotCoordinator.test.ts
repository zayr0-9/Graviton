import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
})
import type { Message } from './chatTypes'
import {
  BRANCH_SNAPSHOT_WINDOW,
  clearConversationSnapshotCoordinatorForTests,
  coordinateConversationSnapshot,
  getTerminalSnapshotLeases,
  recordTerminalSnapshotLease,
} from './conversationSnapshotCoordinator'
import { conversationQueryKeys } from './conversationQueryKeys'
import type { fetchConversationMessagesTree } from './conversationMessagesApi'

const message = (id: string, parentId: string | null): Message => ({
  id,
  conversation_id: 'c1',
  role: 'assistant',
  content: id,
  content_plain_text: id,
  parent_id: parentId,
  children_ids: [],
  created_at: id,
  model_name: 'test',
  partial: false,
  pastedContext: [],
  artifacts: [],
})

const state = (conversationId: string, messages: Message[]) => ({
  chat: {
    conversation: { currentConversationId: conversationId, messages },
    streaming: { activeIds: [], byId: {} },
  },
}) as any

describe('coordinateConversationSnapshot', () => {
  beforeEach(() => clearConversationSnapshotCoordinatorForTests())

  it('rejects an older request and does not write its cache result', async () => {
    const queryClient = new QueryClient()
    let currentState = state('c1', [])
    let resolveFirst!: (value: any) => void
    const first = coordinateConversationSnapshot({
      conversationId: 'c1',
      queryClient,
      getState: () => currentState,
      dispatch: () => undefined,
      fetchSnapshot: () => new Promise(resolve => { resolveFirst = resolve }),
    })
    const second = coordinateConversationSnapshot({
      conversationId: 'c1',
      queryClient,
      getState: () => currentState,
      dispatch: () => undefined,
      fetchSnapshot: async () => ({ messages: [message('new', null)], tree: null }),
    })
    expect((await second).accepted).toBe(true)
    resolveFirst({ messages: [message('old', null)], tree: null })
    expect((await first).accepted).toBe(false)
    expect(queryClient.getQueryData<any>(conversationQueryKeys.messages('c1')).messages[0].id).toBe('new')
  })

  it('treats a wrapped abort as supersession rather than a snapshot failure', async () => {
    const queryClient = new QueryClient()
    const currentState = state('c1', [])
    const dispatch = vi.fn()
    const first = coordinateConversationSnapshot({
      conversationId: 'c1', queryClient, getState: () => currentState, dispatch,
      fetchSnapshot: (_id, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('Local API error (messages/tree): signal is aborted without reason'))
        }, { once: true })
      }),
    })
    let resolveSecond!: (value: any) => void
    const second = coordinateConversationSnapshot({
      conversationId: 'c1', queryClient, getState: () => currentState, dispatch,
      fetchSnapshot: () => new Promise(resolve => { resolveSecond = resolve }),
    })

    await expect(first).resolves.toMatchObject({ accepted: false })
    expect(dispatch).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(conversationQueryKeys.messages('c1'))).toBeUndefined()
    resolveSecond({ messages: [], tree: null })
    await expect(second).resolves.toMatchObject({ accepted: true, data: { messages: [] } })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('still rejects a genuine failure of the current snapshot', async () => {
    const queryClient = new QueryClient()
    const failure = new Error('Database unavailable')
    await expect(coordinateConversationSnapshot({
      conversationId: 'c1', queryClient, getState: () => state('c1', []), dispatch: vi.fn(),
      fetchSnapshot: async () => { throw failure },
    })).rejects.toBe(failure)
  })

  it('rejects a response after the route conversation changes', async () => {
    const queryClient = new QueryClient()
    let currentState = state('c1', [])
    let resolve!: (value: any) => void
    const request = coordinateConversationSnapshot({
      conversationId: 'c1',
      queryClient,
      getState: () => currentState,
      dispatch: () => undefined,
      fetchSnapshot: () => new Promise(done => { resolve = done }),
    })
    currentState = state('c2', [])
    resolve({ messages: [message('late', null)], tree: null })
    expect((await request).accepted).toBe(false)
    expect(queryClient.getQueryData(conversationQueryKeys.messages('c1'))).toBeUndefined()
  })

  it('requests the remembered tip and distinguishes intact, stale and deleted siblings', async () => {
    const rows = ['keep', 'changed', 'deleted'].map(id => ({ ...message(id, 'root'), revision: 1 }))
    const current = state('c1', rows)
    current.chat.conversation.lastViewedTips = { c1: 'tip' }
    const fetchSnapshot = vi.fn(async () => ({ messages: [message('root', null), message('tip', 'root')], tree: null,
      retained: [['keep', 1], ['changed', 2]] as Array<[string, number]> }))
    const result = await coordinateConversationSnapshot({ conversationId: 'c1', queryClient: new QueryClient(),
      branchOnly: true, getState: () => current, dispatch: vi.fn(), fetchSnapshot })
    expect(fetchSnapshot).toHaveBeenCalledWith('c1', expect.objectContaining({ branch: expect.objectContaining({ tip: 'tip' }) }))
    expect(result.data?.messages.map(row => row.id)).toEqual(['keep', 'root', 'tip'])
  })

  it('retains a terminal lease until every protected row is durable', async () => {
    const queryClient = new QueryClient()
    const currentState = state('c1', [message('root', null), message('final', 'root')])
    recordTerminalSnapshotLease({ conversationId: 'c1', streamId: 's1', messageIds: ['root', 'final'] })
    const first = await coordinateConversationSnapshot({
      conversationId: 'c1',
      queryClient,
      getState: () => currentState,
      dispatch: () => undefined,
      fetchSnapshot: async () => ({ messages: [message('root', null)], tree: null }),
    })
    expect(first.data?.messages.map(row => row.id)).toEqual(['root', 'final'])
    expect(getTerminalSnapshotLeases('c1')).toHaveLength(1)

    await coordinateConversationSnapshot({
      conversationId: 'c1',
      queryClient,
      getState: () => currentState,
      dispatch: () => undefined,
      fetchSnapshot: async () => ({ messages: [message('root', null), message('final', 'root')], tree: null }),
    })
    expect(getTerminalSnapshotLeases('c1')).toHaveLength(0)
  })
})

describe('branch window', () => {
  beforeEach(() => clearConversationSnapshotCoordinatorForTests())

  it('asks a branch read for the newest window only and passes compacted rows through unchanged', async () => {
    const queryClient = new QueryClient()
    const compacted: Message = { ...message('old', null), revision: 1, body_omitted: true, content_blocks: [] }
    const fetchSnapshot = vi.fn<typeof fetchConversationMessagesTree>().mockResolvedValue({ messages: [compacted, message('tip', 'old')], tree: null, retained: [] })
    const dispatched: Array<{ payload: { messages: Message[] } }> = []
    const result = await coordinateConversationSnapshot({ conversationId: 'c1', branchOnly: true, queryClient, getState: () => state('c1', []), dispatch: action => dispatched.push(action), fetchSnapshot })
    expect(fetchSnapshot).toHaveBeenCalledWith('c1', expect.objectContaining({ window: BRANCH_SNAPSHOT_WINDOW, branch: expect.any(Object) }))
    expect(result.accepted).toBe(true)
    expect(dispatched[0].payload.messages.map(row => [row.id, row.body_omitted ?? false])).toEqual([['old', true], ['tip', false]])
  })

  it('never asks a full read for a window', async () => {
    const fetchSnapshot = vi.fn<typeof fetchConversationMessagesTree>().mockResolvedValue({ messages: [], tree: null })
    await coordinateConversationSnapshot({ conversationId: 'c1', queryClient: new QueryClient(), getState: () => state('c1', []), dispatch: () => undefined, fetchSnapshot })
    expect(fetchSnapshot.mock.calls[0][1]).not.toHaveProperty('window')
  })
})
