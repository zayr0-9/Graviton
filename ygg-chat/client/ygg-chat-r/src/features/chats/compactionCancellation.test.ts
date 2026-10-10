import './__testSupport__/localStorageShim'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', async original => ({
  ...await original<typeof import('../../utils/api')>(),
  localApi: { post: vi.fn() },
}))
import { localApi } from '../../utils/api'
import { abortCompaction, compactBranch } from './chatActions'
import reducer from './chatSlice'
import type { RootState } from '../../store/store'

describe('compaction cancellation', () => {
  it('only cancels the matching conversation and parent and clears loading without adding a summary', async () => {
    const state = { chat: reducer(undefined, { type: 'init' }) } as RootState
    const dispatch = (action: any) => { state.chat = reducer(state.chat, action); return action }
    const extra = { auth: { accessToken: null, userId: null }, queryClient: null }
    let signal!: AbortSignal
    vi.mocked(localApi.post).mockImplementation((_path, _body, options: any) => {
      signal = options.signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const pending = compactBranch({ conversationId: 'c', parentMessageId: 'a', messages: [
      { id: 'u', role: 'user', content: 'Task' }, { id: 'a', role: 'assistant', content: 'Progress' },
    ] as any, providerName: 'openaichatgpt', modelName: 'test' })(dispatch, () => state, extra)
    expect(state.chat.composition.compactingParentMessageId).toBe('a')
    const competing = await compactBranch({ conversationId: 'c', parentMessageId: 'b', messages: [],
      providerName: 'openaichatgpt', modelName: 'test',
    })(dispatch, () => state, extra)
    expect(competing.type).toBe(compactBranch.rejected.type)
    expect(state.chat.composition.compactingParentMessageId).toBe('a')
    await abortCompaction({ conversationId: 'other', parentMessageId: 'a' })(dispatch, () => state, extra)
    await abortCompaction({ conversationId: 'c', parentMessageId: 'other' })(dispatch, () => state, extra)
    expect(signal.aborted).toBe(false)
    await abortCompaction({ conversationId: 'c', parentMessageId: 'a' })(dispatch, () => state, extra)
    const result = await pending
    expect(signal.aborted).toBe(true)
    expect(result.type).toBe(compactBranch.fulfilled.type)
    expect(state.chat.composition.compacting).toBe(false)
    expect(state.chat.composition.compactingParentMessageId).toBeNull()
    expect(state.chat.conversation.messages).toEqual([])
  })
})
