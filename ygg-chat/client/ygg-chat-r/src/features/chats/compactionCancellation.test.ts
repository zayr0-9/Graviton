import './__testSupport__/localStorageShim'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', async original => ({
  ...await original<typeof import('../../utils/api')>(),
  localApi: { post: vi.fn() },
}))
import { localApi } from '../../utils/api'
import { compactBranch } from './chatActions'
import reducer from './chatSlice'
import type { RootState } from '../../store/store'

describe('compaction cancellation', () => {
  it('uses the normal send abort handle, not a standalone HTTP compactor', async () => {
    const state = { chat: reducer(undefined, { type: 'init' }) } as RootState
    let rejectSend!: (error: Error) => void
    const child = { unwrap: () => new Promise((_resolve, reject) => { rejectSend = reject }),
      abort: vi.fn(() => rejectSend(new Error('Cancelled'))) }
    const dispatch = (action: any) => {
      if (typeof action === 'function') return child
      state.chat = reducer(state.chat, action); return action
    }
    const pending = compactBranch({ conversationId: 'c', parentMessageId: 'a', messages: [] })(dispatch, () => state,
      { auth: { accessToken: null, userId: null }, queryClient: null })
    pending.abort()
    await pending
    expect(child.abort).toHaveBeenCalledOnce()
    expect(localApi.post).not.toHaveBeenCalled()
    expect(state.chat.conversation.messages).toEqual([])
  })
})
