import './__testSupport__/localStorageShim'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', async original => ({ ...await original<typeof import('../../utils/api')>(),
  buildLocalApiUrl: async (path: string) => `http://localhost/api${path}`,
}))
vi.mock('./runAdmissionClient', () => ({ getAdmissionEpoch: async () => 'epoch' }))
import { enqueueUserMessage } from './chatActions'
import reducer from './chatSlice'
import type { RootState } from '../../store/store'

import { getPendingFullAccessNotification, setFullAccessEnabled } from '../../helpers/fullAccessSettings'

afterEach(() => { vi.unstubAllGlobals(); setFullAccessEnabled(false) })
const setup = () => {
  const state = { chat: reducer(undefined, { type: 'init' }) } as RootState
  const dispatch = (action: any) => { state.chat = reducer(state.chat, action); return action }
  const run = () => enqueueUserMessage({ conversationId: 'c', streamId: 's', content: 'next instruction', requestId: 'q', includeGlobalComposerContext: false })(dispatch, () => state, { auth: { userId: null }, queryClient: null })
  return { run, state }
}
describe('enqueueUserMessage', () => {
  it('carries the pending Full access notice without consuming it before persistence', async () => {
    setFullAccessEnabled(true, 'c')
    const notificationId = getPendingFullAccessNotification('c')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ streamId: 's' })))
    vi.stubGlobal('fetch', fetchMock)
    const { run } = setup()
    expect((await run()).type).toBe(enqueueUserMessage.fulfilled.type)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      fullAccess: true, fullAccessNotificationId: notificationId,
    })
    expect(getPendingFullAccessNotification('c')).toBe(notificationId)
  })

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

describe('prepared card queue transport', () => {
  const prepared = { epoch: 'original-epoch', fullAccess: false }
  const runCard = (requestId = 'card-request') => {
    const { state } = setup()
    const actions: any[] = []
    const dispatch = (action: any) => {
      actions.push(action)
      if (typeof action !== 'function') state.chat = reducer(state.chat, action)
      return action
    }
    return { state, actions, result: enqueueUserMessage({ conversationId: 'background', streamId: 'retained',
      content: 'follow-up', requestId, preparedTextSubmission: prepared,
      includeGlobalComposerContext: false, updatePath: false })(dispatch, () => state, { auth: { userId: null }, queryClient: null }) }
  }
  it('returns acceptance and attaches only the accepted background stream, without global context', async () => {
    setFullAccessEnabled(true, 'foreground')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ streamId: 'successor', restarted: true, parentId: 'head' })))
    vi.stubGlobal('fetch', fetchMock)
    const { result, state, actions } = runCard()
    const before = state.chat.composition
    expect((await result).payload).toEqual({ streamId: 'successor', restarted: true, requestId: 'card-request' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ epoch: 'original-epoch', requestId: 'card-request', content: 'follow-up', fullAccess: false,
      selectedFiles: [], attachmentsBase64: null })
    expect(fetchMock.mock.calls[0][0]).toContain('/conversations/background/streams/retained/queue')
    expect(state.chat.composition).toBe(before)
    expect(actions.filter(action => typeof action === 'function')).toHaveLength(1)
  })
  it.each(['failed', 'cancelled'])('does not resubmit an already accepted successor with terminal outcome %s', async outcome => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ streamId: 'successor', restarted: true,
      receipt: { disposition: 'restarted', outcome } }))))
    expect((await runCard().result).type).toBe(enqueueUserMessage.fulfilled.type)
  })
  it('reports malformed success and network failure as uncertain, not safe to resubmit with a new ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid JSON')))
    expect((await runCard().result).payload).toMatchObject({ uncertain: true })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect((await runCard().result).payload).toMatchObject({ uncertain: true })
  })
  it('returns policy rejection for explicit card acknowledgement without opening a global dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'configuration_mismatch', fullAccess: true, error: 'Uses Full access' }), { status: 409 })))
    expect((await runCard().result).payload).toEqual({ uncertain: false, code: 'configuration_mismatch', fullAccess: true, message: 'Uses Full access' })
  })
  it('uses identical frozen payload on a later user retry even after global policy changes', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ streamId: 'retained' })))
    vi.stubGlobal('fetch', fetchMock)
    await runCard().result
    setFullAccessEnabled(true, 'background')
    await runCard().result
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[2][1].body)
  })
})
