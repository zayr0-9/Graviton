import { afterEach, describe, expect, it, vi } from 'vitest'

// chatSlice (pulled in transitively) reads localStorage at module-init; this env is
// node-without-localStorage. Install a memory shim BEFORE imports evaluate.
vi.hoisted(() => {
  if (typeof (globalThis as any).localStorage === 'undefined') {
    const store = new Map<string, string>()
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    }
  }
})

// buildLocalApiUrl -> deterministic origin so we can assert exact URLs.
vi.mock('../../utils/api', () => ({
  // Mirrors the real builder: getLocalApiBase() returns `<origin>/api`, so the
  // mock MUST add /api too or it hides double-prefix bugs at the call sites.
  buildLocalApiUrl: async (p: string) => `http://local/api${p}`,
  FORCE_LOGOUT_EVENT: 'force-logout',
}))
vi.mock('../../platform/clientCapabilities', () => ({ isHostClient: false }))
// Force resumable behavior on (decoupled from localStorage/env).
vi.mock('../../helpers/serverLoopSettings', () => ({ isResumableRunsEnabled: () => true }))
// Keep watchdog tests fast and prove mainChatClient reads the persisted setting.
vi.mock('../../helpers/toolExecutionSettings', () => ({ getStreamIdleTimeoutMs: () => 1_000 }))

import { runServerChatLoop, runServerReattach, postStreamAbort, getChatStreamErrorEnvelope } from './mainChatClient'
import { getPendingFullAccessNotification, setFullAccessEnabled } from '../../helpers/fullAccessSettings'

/** Build a fake SSE Response from a list of events (one `data:` frame each). */
function sseResponse(events: unknown[], opts: { status?: number } = {}): Response {
  const status = opts.status ?? 200
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
  const chunks = [new TextEncoder().encode(body)]
  let i = 0
  const stream = {
    getReader() {
      return {
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: async () => {},
      }
    },
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    body: status >= 200 && status < 300 ? stream : null,
    text: async () => body,
  } as unknown as Response
}

const goneResponse = (): Response =>
  ({ ok: false, status: 410, body: null, text: async () => '' }) as unknown as Response

const collectDispatch = () => {
  const actions: any[] = []
  return { dispatch: (a: unknown) => actions.push(a), getState: () => ({}), actions }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('postStreamAbort', () => {
  it('POSTs to the abort route and returns ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    expect(await postStreamAbort('s-1')).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://local/api/streams/s-1/abort',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
    )
  })

  // A failed Stop used to return a bare `false` that no caller could explain. It now
  // carries an envelope, because "the server may still be generating" is something the
  // user has to be told — silently reporting a clean stop is a lie.
  it('never throws on network error, and reports why the stop is unconfirmed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    const result = await postStreamAbort('s-1')
    expect(result.ok).toBe(false)
    expect(result.envelope?.code).toBe('stop_not_confirmed')
    // Raw text belongs in `detail`, never in the string the user reads.
    expect(result.envelope?.detail).toContain('down')
    expect(result.envelope?.userMessage).not.toContain('down')
  })
})

describe('runServerReattach', () => {
  it('replays a live run to its terminal complete', async () => {
    const events = [
      { type: 'started', parentId: 'p1', seq: 1 },
      { type: 'chunk', part: 'text', delta: 'hi', seq: 2 },
      { type: 'complete', message: { id: 'a1' }, seq: 3 },
    ]
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(events))
    vi.stubGlobal('fetch', fetchMock)
    const deps = collectDispatch()

    const res = await runServerReattach(
      { streamId: 's-1', conversationId: 'c1', operation: 'send', fromSeq: 0, signal: new AbortController().signal },
      deps
    )

    expect(fetchMock).toHaveBeenCalledWith('http://local/api/streams/s-1?fromSeq=0&bootstrap=1', expect.anything())
    expect(res).toMatchObject({ gone: false, terminal: true, messageId: 'a1' })
    expect(deps.actions.length).toBeGreaterThan(0)
    expect(deps.actions).toContainEqual(expect.objectContaining({
      type: 'agentRunPreviews/messageReceived',
      payload: expect.objectContaining({ streamId: 's-1', message: expect.objectContaining({ id: 'a1' }) }),
    }))
  })

  it('returns gone:true when the server has no live run (410)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(goneResponse()))
    const res = await runServerReattach(
      { streamId: 's-x', conversationId: 'c1', operation: 'send', fromSeq: 0, signal: new AbortController().signal },
      collectDispatch()
    )
    expect(res).toMatchObject({ gone: true, terminal: false })
  })
})

describe('runServerChatLoop resubscribe', () => {
  it('uses the configured stream idle timeout when no SSE bytes arrive', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn().mockResolvedValue(undefined)
    const hangingResponse = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel,
        }),
      },
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hangingResponse))

    const run = runServerChatLoop(
      {
        operation: 'send',
        conversationId: 'c1',
        streamId: 's-idle',
        path: '/conversations/c1/messages',
        request: {},
        signal: new AbortController().signal,
      },
      collectDispatch()
    )
    const settled = run.catch(caught => caught)

    await vi.advanceTimersByTimeAsync(1_000)
    const error = await settled

    expect(getChatStreamErrorEnvelope(error)).toMatchObject({ code: 'stream_stalled' })
    expect(error.message).toContain('1000ms')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('resubscribes from the last seq after a non-terminal drop and finishes the run', async () => {
    // Initial POST ends WITHOUT a terminal event (a drop). The reattach GET carries the tail.
    const post = sseResponse([
      { type: 'started', parentId: 'p1', seq: 1 },
      { type: 'chunk', part: 'text', delta: 'a', seq: 2 },
    ])
    const reattach = sseResponse([
      { type: 'chunk', part: 'text', delta: 'b', seq: 3 },
      { type: 'complete', message: { id: 'a1' }, seq: 4 },
    ])
    const fetchMock = vi.fn().mockResolvedValueOnce(post).mockResolvedValueOnce(reattach)
    vi.stubGlobal('fetch', fetchMock)
    const deps = collectDispatch()

    const result = await runServerChatLoop(
      {
        operation: 'send',
        conversationId: 'c1',
        streamId: 's-1',
        path: '/api/conversations/c1/messages',
        request: {},
        signal: new AbortController().signal,
      },
      deps
    )

    expect(result.messageId).toBe('a1')
    // The reattach used the cursor from the last applied seq (2), not 0.
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://local/api/streams/s-1?fromSeq=2', expect.anything())
  })

  it('merges tools_updated definitions into the renderer tool registry', async () => {
    const post = sseResponse([
      {
        type: 'tools_updated',
        tools: [{
          name: 'mcp__auto-refresh-test__echo',
          description: 'Echo input',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          serverName: 'auto-refresh-test',
          toolName: 'echo',
          ui: { visibility: ['model', 'app'] },
        }],
        seq: 1,
      },
      { type: 'complete', message: { id: 'a-tools' }, seq: 2 },
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(post))
    const deps = collectDispatch()

    await runServerChatLoop(
      {
        operation: 'send',
        conversationId: 'c1',
        streamId: 's-tools',
        path: '/api/conversations/c1/messages',
        request: {},
        signal: new AbortController().signal,
      },
      deps
    )

    const setTools = deps.actions.find(action => action.type === 'chat/setTools')
    expect(setTools?.payload).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'mcp__auto-refresh-test__echo',
        isMcp: true,
        mcpServerName: 'auto-refresh-test',
        mcpToolName: 'echo',
      }),
    ]))
  })

  it('carries optimistic image artifacts onto the server-assigned user message', async () => {
    const post = sseResponse([
      {
        type: 'user_message_persisted',
        message: {
          id: 'u1',
          conversation_id: 'c1',
          role: 'user',
          content: 'image',
          children_ids: [],
          created_at: new Date().toISOString(),
        },
        seq: 1,
      },
      { type: 'complete', message: { id: 'a1' }, seq: 2 },
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(post))
    const deps = collectDispatch()

    const result = await runServerChatLoop(
      {
        operation: 'send',
        conversationId: 'c1',
        streamId: 's-images',
        path: '/api/conversations/c1/messages',
        request: {},
        signal: new AbortController().signal,
      },
      { ...deps, userMessageArtifacts: ['data:image/png;base64,YQ=='] }
    )

    expect(result.userMessage?.artifacts).toEqual(['data:image/png;base64,YQ=='])
    const added = deps.actions.find(action => action.type === 'chat/messageAdded')
    expect(added?.payload?.artifacts).toEqual(['data:image/png;base64,YQ=='])
  })

  it('does NOT resubscribe when the run was cancelled locally (signal aborted)', async () => {
    const ac = new AbortController()
    ac.abort()
    const post = sseResponse([{ type: 'started', parentId: 'p1', seq: 1 }]) // no terminal
    const fetchMock = vi.fn().mockResolvedValueOnce(post)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      runServerChatLoop(
        {
          operation: 'send',
          conversationId: 'c1',
          streamId: 's-1',
          path: '/api/conversations/c1/messages',
          request: {},
          signal: ac.signal,
        },
        collectDispatch()
      )
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(fetchMock).toHaveBeenCalledTimes(1) // no reattach attempt
  })
})


describe('runServerChatLoop reauthentication', () => {
  // Deliberate behaviour change: an expired session used to yank the user out of the app
  // mid-generation (force-logout event -> ProtectedRoute -> /login). It now classifies as
  // `session_expired` and lets the chat render a bubble with a Sign in button, so the user
  // keeps their place and their partial reply, and chooses when to leave.
  it('classifies reauthentication as session_expired WITHOUT forcing navigation', async () => {
    const dispatchEvent = vi.fn()
    ;(globalThis as any).window = { dispatchEvent, location: { hash: '' } }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse([{ type: 'reauth_required', message: 'Sign in again.' }, { type: 'error', error: 'raw 401' }]))
    )

    const error = await runServerChatLoop(
      {
        streamId: 's-auth',
        conversationId: 'c1',
        operation: 'send',
        path: '/api/conversations/c1/messages',
        request: {},
        signal: new AbortController().signal,
      },
      collectDispatch()
    ).catch(e => e)

    const envelope = getChatStreamErrorEnvelope(error)
    expect(envelope?.code).toBe('session_expired')
    expect(envelope?.action?.kind).toBe('sign_in')
    expect(envelope?.recoverability).toBe('user_action')

    // The whole point of the change: no side effect yanks the user anywhere.
    expect(dispatchEvent).not.toHaveBeenCalled()
    expect((globalThis as any).window.location.hash).toBe('')
  })
})

describe('deferred Full access acknowledgement', () => {
  it('acknowledges only the notice and leaves image consumption/optimistic clearing to the real user row', async () => {
    setFullAccessEnabled(true, 'c1')
    const requestId = getPendingFullAccessNotification('c1')!
    const onUserMessagePersisted = vi.fn()
    const events = [
      { type: 'started', parentId: 'u1', seq: 1 },
      { type: 'user_message_persisted', message: { id: 'u1', conversation_id: 'c1', role: 'user', parent_id: null, content: 'hello' }, seq: 2 },
      { type: 'user_message_persisted', message: { id: 'notice', parent_id: 'u1', conversation_id: 'c1', role: 'user', meta: { kind: 'full_access_change', requestId } }, seq: 3 },
      { type: 'complete', message: { id: 'a1', parent_id: 'notice' }, seq: 4 },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(events)))
    const deps = collectDispatch()
    const result = await runServerChatLoop({ operation: 'send', conversationId: 'c1', streamId: 's1',
      path: '/conversations/c1/messages', request: {}, signal: new AbortController().signal },
      { ...deps, onUserMessagePersisted, userMessageArtifacts: ['data:image/png;base64,YQ=='] })
    expect(getPendingFullAccessNotification('c1')).toBeUndefined()
    expect(onUserMessagePersisted).toHaveBeenCalledOnce()
    expect(result.userMessage?.id).toBe('u1')
    expect(result.userMessage?.artifacts).toEqual(['data:image/png;base64,YQ=='])
    expect(deps.actions.filter(action => action.type === 'chat/optimisticMessageCleared')).toHaveLength(1)
    setFullAccessEnabled(false)
  })
})

describe('multi-client replay sequence', () => {
  it('does not project a duplicate token frame twice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      { type: 'started', parentId: 'p1', seq: 1 },
      { type: 'chunk', part: 'text', delta: 'once', seq: 2 },
      { type: 'chunk', part: 'text', delta: 'once', seq: 2 },
      { type: 'complete', message: { id: 'answer' }, seq: 3 },
    ])))
    const deps = collectDispatch()
    await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', fromSeq: 0, signal: new AbortController().signal }, deps)
    const chunks = deps.actions.filter(action => JSON.stringify(action).includes('"delta":"once"'))
    expect(chunks).toHaveLength(1)
  })
})

it('installs a fresh bootstrap at S and projects only deltas newer than S', async () => {
  const deps = collectDispatch()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
    { type: 'bootstrap', seq: 50, snapshot: { kind: 'main', schema: 1, epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 50,
      persisted: [], pendingDecisions: [], queueRevision: 0, events: [{ type: 'chunk', part: 'text', delta: 'before' }] } },
    { type: 'chunk', part: 'text', delta: 'after', seq: 51 },
    { type: 'complete', message: { id: 'm' }, seq: 52 },
  ])))
  const result = await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', signal: new AbortController().signal }, deps)
  expect(result.terminal).toBe(true)
  expect(deps.actions.some(action => action.type === 'chat/streamBootstrapReset')).toBe(true)
  expect(deps.actions.filter(action => action.payload?.chunk?.delta).map(action => action.payload.chunk.delta)).toEqual(['before', 'after'])
})

// Production snapshots retain only the previous anchor/current turn, not every
// assistant persistence event. Offline turns arrive as rows without navigation events.
it.each(['primary', 'observer', 'sibling', 'parallel'])('recovers compact reconnect history without rewinding %s', async kind => {
  const { default: reducer, chatSliceActions: actions } = await import('./chatSlice')
  const { applyStreamProjectionPolicy } = await import('./sseProjection')
  const row = (id: string, parent_id: string | null, role = 'assistant') => ({ id, parent_id, role,
    conversation_id: 'c', revision: 1, content: '', children_ids: [], created_at: '2026-01-01', content_blocks: [] }) as any
  const rows = [row('u', null, 'user'), row('a1', 'u'), row('a2', 'a1'), row('a3', 'a2')]
  let state = reducer(undefined, { type: 'init' })
  const dispatch = (action: any) => { state = reducer(state, applyStreamProjectionPolicy(action,
    { streamId: 's', streamType: kind === 'primary' ? 'primary' : 'branch', updatePath: kind === 'primary' })) }
  dispatch(actions.conversationSet('c'))
  for (const message of rows.slice(0, 2)) dispatch(actions.messageAdded(message))
  dispatch(actions.messageAdded(row('sibling', 'u')))
  dispatch(actions.conversationPathSet(['u', kind === 'sibling' ? 'sibling' : 'a1']))
  dispatch(actions.sendingStarted({ streamId: 's', conversationId: 'c', updatePath: kind === 'primary',
    followSelectedTip: kind === 'observer' || kind === 'sibling' }))
  const bootstrap = { type: 'bootstrap', snapshot: { kind: 'main', schema: 1, epoch: 'e', streamId: 's',
    conversationId: 'c', stateSeq: 50, persisted: rows.map(row => ({ id: row.id, revision: 1, row })),
    events: [{ type: 'started', parentId: 'u' }, { type: 'user_message_persisted', message: rows[0] },
      { type: 'assistant_message_persisted', message: rows[3] }, { type: 'tool_loop', status: 'turn_started', turn: 4 }],
    pendingDecisions: [], queueRevision: 0 } }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([bootstrap,
    { type: 'complete', message: row('final', 'a3'), seq: 51 }])))
  await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', signal: new AbortController().signal },
    { dispatch, getState: () => ({ chat: state }) } as any)
  expect(state.conversation.currentPath).toEqual(kind === 'sibling' ? ['u', 'sibling'] :
    kind === 'parallel' ? ['u', 'a1'] : ['u', 'a1', 'a2', 'a3', 'final'])
})

it.each([false, true])('keeps restored context through terminal compact bootstrap (observer=%s)', async observer => {
  const { default: reducer, chatSliceActions: actions } = await import('./chatSlice')
  const { applyStreamProjectionPolicy } = await import('./sseProjection')
  const row = (id: string, parent_id: string | null, role = 'assistant', meta?: object) => ({ id, parent_id, role, meta,
    conversation_id: 'c', revision: 1, content: '', children_ids: [], created_at: '2026-01-01', content_blocks: [] }) as any
  const rows = [row('u', null, 'user'), row('summary', 'u'), row('context', 'summary', 'user', { kind: 'context_injection' })]
  let state = reducer(undefined, { type: 'init' })
  const dispatch = (action: any) => { state = reducer(state, applyStreamProjectionPolicy(action,
    { streamId: 's', streamType: 'primary', updatePath: !observer })) }
  dispatch(actions.conversationSet('c'))
  dispatch(actions.messageAdded(rows[0]))
  dispatch(actions.conversationPathSet(['u']))
  dispatch(actions.sendingStarted({ streamId: 's', conversationId: 'c', updatePath: !observer, followSelectedTip: observer }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([{ type: 'bootstrap', snapshot: {
    kind: 'main', schema: 1, epoch: 'e', streamId: 's', conversationId: 'c', stateSeq: 50,
    persisted: rows.map(row => ({ id: row.id, revision: 1, row })), pendingDecisions: [], queueRevision: 0,
    events: [{ type: 'user_message_persisted', message: rows[0] }, { type: 'assistant_message_persisted', message: rows[1] },
      { type: 'context_injection_persisted', message: rows[2] }, { type: 'complete', message: rows[1] }] } }])))
  const result = await runServerReattach({ streamId: 's', conversationId: 'c', operation: 'send', signal: new AbortController().signal },
    { dispatch, getState: () => ({ chat: state }) } as any)
  expect(result.terminal).toBe(true)
  expect(state.conversation.currentPath).toEqual(['u', 'summary', 'context'])
  expect(state.streaming.byId.s.finalMessageId).toBe('context')
})
