import './__testSupport__/localStorageShim'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', async original => ({ ...await original<typeof import('../../utils/api')>(),
  buildLocalApiUrl: async (path: string) => `http://localhost/api${path}`,
}))
import { enqueueUserMessage } from './chatActions'
import reducer from './chatSlice'
import type { RootState } from '../../store/store'

afterEach(() => vi.unstubAllGlobals())
const setup = () => {
  const state = { chat: reducer(undefined, { type: 'init' }) } as RootState
  const dispatch = (action: any) => { state.chat = reducer(state.chat, action); return action }
  const run = () => enqueueUserMessage({ conversationId: 'c', streamId: 's', content: 'next instruction', requestId: 'q', includeGlobalComposerContext: false })(dispatch, () => state, { auth: { accessToken: null, userId: null }, queryClient: null })
  return { run, state }
}
describe('enqueueUserMessage', () => {
  it('retries a lost acknowledgement with the same id/payload and does not start a competing stream', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(new Response(JSON.stringify({ streamId: 's', snapshot: {
      streamId: 's', conversationId: 'c', lineageId: 'l', revision: 1, items: [{ requestId: 'q', content: 'next instruction', attachmentCount: 0, status: 'queued' }],
    } })))
    vi.stubGlobal('fetch', fetchMock)
    const { run, state } = setup()
    const result = await run()
    expect(result.type).toBe(enqueueUserMessage.fulfilled.type)
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body)
    expect(state.chat.messageQueues.s.items[0].content).toBe('next instruction')
    expect(state.chat.streaming.activeIds).toEqual([])
  })
})
