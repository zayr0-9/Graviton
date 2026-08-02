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
vi.mock('../../utils/api', () => ({ buildLocalApiUrl: async (p: string) => `http://local${p}` }))
// Force resumable behavior on (decoupled from localStorage/env).
vi.mock('../../helpers/serverLoopSettings', () => ({ isResumableRunsEnabled: () => true }))

import { runServerChatLoop, runServerReattach, postStreamAbort } from './mainChatClient'

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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('postStreamAbort', () => {
  it('POSTs to the abort route and returns ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    expect(await postStreamAbort('s-1')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://local/api/streams/s-1/abort',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
    )
  })

  it('never throws on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(await postStreamAbort('s-1')).toBe(false)
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

    expect(fetchMock).toHaveBeenCalledWith('http://local/api/streams/s-1?fromSeq=0', expect.anything())
    expect(res).toMatchObject({ gone: false, terminal: true, messageId: 'a1' })
    expect(deps.actions.length).toBeGreaterThan(0)
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
