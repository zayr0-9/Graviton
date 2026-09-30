import './__testSupport__/localStorageShim'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', async original => ({
  ...await original<typeof import('../../utils/api')>(),
  buildLocalApiUrl: async (path: string) => `http://localhost/api${path}`,
}))
import { changeOperationMode } from './chatActions'
import reducer, { chatSliceActions } from './chatSlice'
import { selectOperationMode } from './chatSelectors'
import type { RootState } from '../../store/store'

function setup() {
  const initial = reducer(undefined, { type: 'init' })
  const state = { chat: { ...initial, conversation: { ...initial.conversation, currentConversationId: 'c' } } } as RootState
  const dispatch = (action: any) => { state.chat = reducer(state.chat, action); return action }
  const run = (streamId?: string) => changeOperationMode({ mode: 'execute', conversationId: 'c', parentId: null, streamId })(dispatch, () => state, { auth: { accessToken: null, userId: null }, queryClient: null })
  return { state, run }
}
afterEach(() => vi.unstubAllGlobals())

describe('changeOperationMode thunk', () => {
  it('posts to the active run without starting generation and waits for its notification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'pending', mode: 'execute', revision: 1 })))
    vi.stubGlobal('fetch', fetchMock)
    const { run, state } = setup()
    await run('s')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ streamId: 's', mode: 'execute', parentId: null })
    expect(state.chat.operationMode).toBe('execute')
    expect(state.chat.operationModeChanges.c.status).toBe('pending')
    expect(state.chat.streaming.activeIds).toEqual([])
  })

  it('coalesces repeated idle selections without requests or transcript rows', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { run, state } = setup()
    for (let i = 0; i < 20; i++) await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(selectOperationMode({ ...state })).toBe('execute')
    expect(state.chat.conversation.currentPath).toEqual([])
    expect(state.chat.conversation.messages).toEqual([])
    expect(Object.keys(state.chat.operationModeDrafts)).toHaveLength(1)
    expect(state.chat.operationModeChanges.c).toBeUndefined()
    expect(state.chat.streaming.activeIds).toEqual([])
  })

  it('keeps idle selection local to the branch and overrides its previous announcement', () => {
    const { state } = setup()
    state.chat.conversation.messages = [{ id: 'a', role: 'user', meta: { kind: 'operation_mode_change', mode: 'plan' } } as any]
    state.chat.conversation.currentPath = ['a']
    state.chat = reducer(state.chat, chatSliceActions.operationModeDraftSet({ conversationId: 'c', parentId: 'a', mode: 'execute' }))
    expect(selectOperationMode({ ...state })).toBe('execute')
    state.chat = { ...state.chat, conversation: { ...state.chat.conversation, currentPath: ['b'] } }
    expect(selectOperationMode({ ...state })).toBe('plan')
    state.chat = { ...state.chat, conversation: { ...state.chat.conversation, currentPath: ['a'] } }
    expect(selectOperationMode({ ...state })).toBe('execute')
  })

  it('leaves the old mode and reports failure when a stale stream rejects the command', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Run no longer active' }), { status: 409 })))
    const { run, state } = setup()
    const result = await run('stale')
    expect(result.type).toBe(changeOperationMode.rejected.type)
    expect(state.chat.operationMode).toBe('plan')
    expect(state.chat.operationModeChanges.c).toBeUndefined()
  })
})
