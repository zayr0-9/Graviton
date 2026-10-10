import './__testSupport__/localStorageShim'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', async original => ({
  ...await original<typeof import('../../utils/api')>(),
  gwApi: { patch: vi.fn() },
}))
import { gwApi } from '../../utils/api'
import { updateConversationTitle } from './chatActions'
import reducer from '../conversations/conversationSlice'
import type { Conversation } from '../conversations/conversationTypes'
import type { RootState } from '../../store/store'

const original = { id: 'c', title: 'Original', storage_mode: 'local', project_id: 'p' } as Conversation
const other = { id: 'other', title: 'Other' } as Conversation
const clients: QueryClient[] = []
function setup() {
  const queryClient = new QueryClient()
  clients.push(queryClient)
  const state = { conversations: { ...reducer(undefined, { type: 'init' }), items: [original, other] } } as RootState
  const dispatch = (action: any) => { state.conversations = reducer(state.conversations, action); return action }
  const run = (storageMode?: 'local' | 'cloud') => updateConversationTitle({ id: 'c', title: 'Renamed', storageMode })(
    dispatch, () => state, { auth: { accessToken: null, userId: null }, queryClient }
  )
  return { queryClient, state, run }
}
afterEach(() => {
  vi.clearAllMocks()
  clients.splice(0).forEach(client => client.clear())
})

describe('explicit conversation title save', () => {
  it('persists using the authoritative mode and syncs Redux and all supported flat/infinite caches', async () => {
    const { queryClient, state, run } = setup()
    const flatKeys = [['conversations'], ['conversations', 'recent', 10], ['conversations', 'project', 'p']]
    const infiniteKeys = [['conversations', 'infinite'], ['conversations', 'project', 'p', 'infinite']]
    flatKeys.forEach(key => queryClient.setQueryData(key, [original, other]))
    infiniteKeys.forEach(key => queryClient.setQueryData(key, { pages: [{ conversations: [original, other], nextCursor: 'next' }], pageParams: [null] }))
    vi.mocked(gwApi.patch).mockResolvedValue({ ...original, title: 'Renamed' })
    await run('cloud').unwrap()
    expect(gwApi.patch).toHaveBeenCalledOnce()
    expect(gwApi.patch).toHaveBeenCalledWith('/conversations/c?storageMode=cloud', { title: 'Renamed' })
    expect(state.conversations.items[0].title).toBe('Renamed')
    flatKeys.forEach(key => expect(queryClient.getQueryData(key)).toEqual([{ ...original, title: 'Renamed' }, other]))
    infiniteKeys.forEach(key => expect(queryClient.getQueryData(key)).toEqual({ pages: [{ conversations: [{ ...original, title: 'Renamed' }, other], nextCursor: 'next' }], pageParams: [null] }))
  })

  it('keeps persisted and cached titles unchanged when saving fails and rejects unwrap', async () => {
    const { queryClient, state, run } = setup()
    queryClient.setQueryData(['conversations'], [original])
    vi.mocked(gwApi.patch).mockRejectedValue(new Error('Offline'))
    await expect(run('local').unwrap()).rejects.toBe('Offline')
    expect(state.conversations.items[0].title).toBe('Original')
    expect(queryClient.getQueryData(['conversations'])).toEqual([original])
  })

  it('uses the stored mode when a caller does not supply one', async () => {
    const { run } = setup()
    vi.mocked(gwApi.patch).mockResolvedValue({ ...original, title: 'Renamed' })
    await run().unwrap()
    expect(gwApi.patch).toHaveBeenCalledWith('/conversations/c?storageMode=local', { title: 'Renamed' })
  })
})
