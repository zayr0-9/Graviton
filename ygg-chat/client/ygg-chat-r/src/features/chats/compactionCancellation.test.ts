import './__testSupport__/localStorageShim'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', async original => ({
  ...await original<typeof import('../../utils/api')>(),
  localApi: { post: vi.fn() },
}))
import { localApi } from '../../utils/api'
import { compactBranch } from './chatActions'
import reducer, { chatSliceActions } from './chatSlice'
import { createEmptyStreamState } from './streamHelpers'
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

describe('compaction branch ownership', () => {
  const runCompaction = async ({
    streamLineageId = 'running-lineage',
    selectedLineageId = 'moved-lineage',
    streamConversationId = 'a',
    active = true,
    streamAnchor = 'running-tip',
  }: {
    streamLineageId?: string | null
    selectedLineageId?: string | null
    streamConversationId?: string
    active?: boolean
    streamAnchor?: string
  } = {}) => {
    const state = { chat: reducer(undefined, chatSliceActions.lineageSelected({
      conversationId: 'a', lineageId: selectedLineageId, path: ['shared-root', 'moved-user', 'moved-tip'], focus: 'moved-tip',
    })) } as RootState
    const stream = {
      ...createEmptyStreamState('primary', {
        ...(streamLineageId == null ? {} : { lineageId: streamLineageId, lineageIdConfirmed: true }),
        rootMessageId: 'shared-root',
      }),
      active, conversationId: streamConversationId, currentBranchAnchorMessageId: streamAnchor,
    }
    state.chat = { ...state.chat, streaming: {
      ...state.chat.streaming, activeIds: active ? ['running'] : [],
      byId: { running: stream }, primaryStreamId: 'running',
    } }
    const send = vi.fn(() => ({ unwrap: async () => ({ messageId: null }), abort: vi.fn() }))
    const dispatch = (action: any) => {
      if (typeof action === 'function') return send()
      state.chat = reducer(state.chat, action)
      return action
    }
    const result = await compactBranch({ conversationId: 'a', parentMessageId: 'moved-tip', messages: [] })(
      dispatch, () => state, { auth: { accessToken: null, userId: null }, queryClient: null })
    return { result, send }
  }

  it('allows a moved branch while another lineage streams in the destination conversation', async () => {
    // Even shared legacy anchors must not override distinct confirmed lineages.
    const { result, send } = await runCompaction({ streamAnchor: 'moved-tip' })
    expect(result.meta.requestStatus).toBe('fulfilled')
    expect(send).toHaveBeenCalledOnce()
  })

  it('rejects compaction on the active lineage even when its stream head has advanced', async () => {
    const { result, send } = await runCompaction({ streamLineageId: 'moved-lineage' })
    expect(result.payload).toBe('Wait for the active run to finish before compacting')
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores a run in another conversation', async () => {
    const { result, send } = await runCompaction({ streamConversationId: 'b', streamLineageId: 'moved-lineage' })
    expect(result.meta.requestStatus).toBe('fulfilled')
    expect(send).toHaveBeenCalledOnce()
  })

  it('allows compaction after the same branch run finishes', async () => {
    const { result, send } = await runCompaction({ active: false, streamLineageId: 'moved-lineage' })
    expect(result.meta.requestStatus).toBe('fulfilled')
    expect(send).toHaveBeenCalledOnce()
  })

  it('blocks a matching legacy branch without lineage metadata', async () => {
    const { result, send } = await runCompaction({
      streamLineageId: null, selectedLineageId: null, streamAnchor: 'moved-tip',
    })
    expect(result.payload).toBe('Wait for the active run to finish before compacting')
    expect(send).not.toHaveBeenCalled()
  })

  it('allows an unrelated legacy branch', async () => {
    const { result, send } = await runCompaction({ streamLineageId: null, selectedLineageId: null })
    expect(result.meta.requestStatus).toBe('fulfilled')
    expect(send).toHaveBeenCalledOnce()
  })
})
