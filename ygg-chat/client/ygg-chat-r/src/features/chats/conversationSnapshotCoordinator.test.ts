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
  clearConversationSnapshotCoordinatorForTests,
  coordinateConversationSnapshot,
  getTerminalSnapshotLeases,
  recordTerminalSnapshotLease,
} from './conversationSnapshotCoordinator'
import { conversationQueryKeys } from './conversationQueryKeys'

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
