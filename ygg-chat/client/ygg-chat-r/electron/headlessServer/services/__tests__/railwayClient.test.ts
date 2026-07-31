import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRailwayClient, RailwayHttpError } from '../railwayClient.js'

function jsonResponse(status: number, obj: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(obj),
  } as any
}

function textResponse(status: number, text: string, contentType = 'text/plain') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text,
  } as any
}

function sseResponse(frames: string[]) {
  const enc = new TextEncoder()
  let i = 0
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    text: async () => '',
    body: {
      getReader() {
        return {
          read: async () => (i < frames.length ? { value: enc.encode(frames[i++]), done: false } : { value: undefined, done: true }),
          cancel: async () => {},
        }
      },
    },
  } as any
}

const makeAuth = (accessToken: string | null = 'tok-1') => ({
  getFreshAppToken: vi.fn(async (_opts?: { forceRefresh?: boolean }) => ({ userId: 'u1', accessToken })),
})

describe('railwayClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    ;(globalThis as any).fetch = fetchMock
  })
  afterEach(() => vi.restoreAllMocks())

  it('injects the Bearer token and resolves the configured base for request()', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { hello: 'world' }))
    const auth = makeAuth('tok-abc')
    const client = createRailwayClient({ auth, remoteApiBase: 'https://api.example.com/api/' })
    const out = await client.request<{ hello: string }>({ method: 'GET', path: '/models' })
    expect(out).toEqual({ hello: 'world' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/api/models') // trailing slash trimmed + leading slash joined
    expect((init.headers as any)['Authorization']).toBe('Bearer tok-abc')
  })

  it('sets Content-Type + serializes a JSON body on writes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'c1' }))
    const client = createRailwayClient({ auth: makeAuth(), remoteApiBase: 'https://x/api' })
    await client.request({ method: 'POST', path: '/conversations', body: { title: 't' } })
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as any)['Content-Type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ title: 't' }))
  })

  it('omits Authorization when there is no app token (community/local-only)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    const client = createRailwayClient({ auth: makeAuth(null), remoteApiBase: 'https://x/api' })
    await client.request({ method: 'GET', path: '/models' })
    const [, init] = fetchMock.mock.calls[0]
    expect('Authorization' in (init.headers as any)).toBe(false)
  })

  it('passthrough returns Railway status/body verbatim and never throws on 4xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'nope' }))
    const client = createRailwayClient({ auth: makeAuth(), remoteApiBase: 'https://x/api' })
    const r = await client.passthrough({ method: 'GET', path: '/stripe/pricing-info' })
    expect(r).toEqual({ ok: false, status: 403, body: { error: 'nope' }, contentType: 'application/json' })
  })

  it('request throws RailwayHttpError carrying the status + body on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
    const client = createRailwayClient({ auth: makeAuth(), remoteApiBase: 'https://x/api' })
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      name: 'RailwayHttpError',
      status: 500,
      body: { error: 'boom' },
    })
    expect(RailwayHttpError).toBeDefined()
  })

  it('on 401 forces one refresh and retries exactly once', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const auth = makeAuth('tok-1')
    const client = createRailwayClient({ auth, remoteApiBase: 'https://x/api' })
    const out = await client.request<{ ok: boolean }>({ method: 'GET', path: '/users/u1' })
    expect(out).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // First attempt no force; retry forces a refresh.
    expect(auth.getFreshAppToken).toHaveBeenNthCalledWith(1, undefined)
    expect(auth.getFreshAppToken).toHaveBeenNthCalledWith(2, { forceRefresh: true })
  })

  it('does not retry past one attempt when the refresh still yields 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'expired' }))
    const client = createRailwayClient({ auth: makeAuth(), remoteApiBase: 'https://x/api' })
    const r = await client.passthrough({ method: 'GET', path: '/x' })
    expect(r.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('passthrough returns raw text for non-JSON responses', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, 'plain body', 'text/plain'))
    const client = createRailwayClient({ auth: makeAuth(), remoteApiBase: 'https://x/api' })
    const r = await client.passthrough({ method: 'GET', path: '/x' })
    expect(r.body).toBe('plain body')
    expect(r.contentType).toBe('text/plain')
  })

  it('stream parses SSE data frames and skips [DONE]', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['data: {"n":1}\n\n', 'data: {"n":2}\n\n', 'data: [DONE]\n\n']))
    const client = createRailwayClient({ auth: makeAuth(), remoteApiBase: 'https://x/api' })
    const events: any[] = []
    await client.stream({ method: 'GET', path: '/stream' }, e => events.push(e))
    expect(events).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('stream stops cleanly when the signal is already aborted', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['data: {"n":1}\n\n']))
    const client = createRailwayClient({ auth: makeAuth(), remoteApiBase: 'https://x/api' })
    const controller = new AbortController()
    controller.abort()
    const events: any[] = []
    await expect(client.stream({ method: 'GET', path: '/s' }, e => events.push(e), controller.signal)).resolves.toBeUndefined()
    expect(events).toEqual([])
  })
})
