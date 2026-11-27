import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
})
vi.mock('../../utils/api', () => ({ localApi: { get: vi.fn() } }))

import type { ThunkDispatch, UnknownAction } from '@reduxjs/toolkit'
import type { RootState } from '../../store/store'
import { localApi } from '../../utils/api'
import type { Message } from './chatTypes'
import { clearMessageBodyHydrationForTests, fetchMessageBodies, hydrateMessageBodies, MESSAGE_BODY_BATCH, withHydratedBodies } from './messageBodyHydration'

const get = localApi.get as unknown as ReturnType<typeof vi.fn>

const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id, conversation_id: 'c1', role: 'assistant', content: id, content_plain_text: id, parent_id: null, children_ids: [],
  created_at: id, model_name: 'test', partial: false, pastedContext: [], artifacts: [], ...extra,
})
const idsOf = (url: string) => decodeURIComponent(url.split('ids=')[1]).split(',')
type Dispatched = { type: string; payload?: unknown }
const run = (ids: string[], state: unknown, dispatched: Dispatched[] = []) => {
  const dispatch = ((action: Dispatched) => { dispatched.push(action); return action }) as unknown as ThunkDispatch<RootState, unknown, UnknownAction>
  return hydrateMessageBodies({ conversationId: 'c1', messageIds: ids })(dispatch, () => state as RootState, undefined)
}
const payloadOf = (action: Dispatched) => action.payload as Message[]
const hydratedIds = (action: Dispatched) => (action.payload as { messages: Message[] }).messages.map(row => row.id)

describe('message body hydration', () => {
  beforeEach(() => { get.mockReset(); clearMessageBodyHydrationForTests() })

  it('fetches in bounded batches and returns rows in order', async () => {
    get.mockImplementation(async (url: string) => ({ messages: idsOf(url).map(id => message(id)) }))
    const ids = Array.from({ length: MESSAGE_BODY_BATCH + 5 }, (_, index) => `m${index}`)
    const rows = await fetchMessageBodies('c1', ids)
    expect(get).toHaveBeenCalledTimes(2)
    expect(idsOf(get.mock.calls[0][0])).toHaveLength(MESSAGE_BODY_BATCH)
    expect(rows.map(row => row.id)).toEqual(ids)
  })

  it('requests only compacted rows, shares in-flight requests and installs bodies for the current conversation', async () => {
    const resolvers: Array<(value: { messages: Message[] }) => void> = []
    get.mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    const state = { chat: { conversation: { currentConversationId: 'c1', messages: [
      message('a', { body_omitted: true, revision: 1 }), message('b', { body_omitted: true, revision: 1 }), message('full'),
    ] } } }
    const dispatched: Dispatched[] = []
    const first = run(['a', 'full', 'missing'], state, dispatched)
    const second = run(['a', 'b'], state, dispatched)
    expect(get).toHaveBeenCalledTimes(2)
    expect(idsOf(get.mock.calls[0][0])).toEqual(['a'])
    expect(idsOf(get.mock.calls[1][0])).toEqual(['b'])
    resolvers[1]({ messages: [message('b', { revision: 1 })] })
    resolvers[0]({ messages: [message('a', { revision: 1 })] })
    const [one, two] = await Promise.all([first, second])
    expect(payloadOf(one).map(row => row.id)).toEqual(['a'])
    expect(payloadOf(two).map(row => row.id).sort()).toEqual(['a', 'b'])
    const installed = dispatched.filter(action => action.type === 'chat/messageBodiesHydrated')
    expect(installed.map(hydratedIds)).toEqual([['b'], ['a']])
    // Once settled, a repeat for the same ids goes to the host again (the rows are still flagged in this fixture state).
    get.mockImplementation(async () => ({ messages: [] }))
    await run(['a'], state)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('does not install bodies into a conversation the renderer has left', async () => {
    get.mockImplementation(async (url: string) => ({ messages: idsOf(url).map(id => message(id)) }))
    const state = { chat: { conversation: { currentConversationId: 'other', messages: [message('a', { body_omitted: true })] } } }
    const dispatched: Dispatched[] = []
    const result = await run(['a'], state, dispatched)
    expect(payloadOf(result).map(row => row.id)).toEqual(['a'])
    expect(dispatched.some(action => action.type === 'chat/messageBodiesHydrated')).toBe(false)
  })

  it('merges hydrated rows only over compacted ones', () => {
    const rows = [message('a', { body_omitted: true, body_omitted_chars: 5 }), message('b')]
    const merged = withHydratedBodies(rows, [message('a', { content: 'full' }), message('b', { content: 'ignored' })])
    expect(merged.map(row => [row.id, row.content, row.body_omitted ?? null])).toEqual([['a', 'full', null], ['b', 'b', null]])
  })
})
