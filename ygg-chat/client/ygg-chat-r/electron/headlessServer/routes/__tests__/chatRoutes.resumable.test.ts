import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { registerChatRoutes } from '../chatRoutes.js'
import { RunSessionRegistry } from '../../services/runSessionRegistry.js'

// ── helpers ──────────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Read parsed `data:` events from an SSE response, up to `max` (default: to end). */
async function collect(res: Response, max = Number.POSITIVE_INFINITY): Promise<any[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: any[] = []
  try {
    while (events.length < max) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload) continue
        try {
          events.push(JSON.parse(payload))
        } catch {
          /* ignore partial */
        }
      }
    }
  } catch {
    /* reader aborted — return what we have */
  }
  return events
}

interface Harness {
  baseUrl: string
  server: Server
  /** Release a gated run so it emits its post-gate events. */
  release: () => void
}

function startServer(opts: {
  resumableRuns: boolean
  /** 'gated' waits on a manual release; 'abortable' hangs until the run signal aborts. */
  mode: 'gated' | 'abortable'
}): Harness {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  const app = express()
  app.use(express.json())
  registerChatRoutes(app, {
    orchestrator: {
      async runMessage(request: any, emit: any, signal?: AbortSignal) {
        emit({ type: 'started', operation: request.operation, conversationId: request.conversationId })
        emit({ type: 'chunk', part: 'text', delta: 'a' })
        if (opts.mode === 'gated') {
          await gate
          emit({ type: 'chunk', part: 'text', delta: 'b' })
          emit({ type: 'complete', message: { id: 'assistant-1' } })
        } else {
          // Hang until the run signal aborts (explicit cancel / reaper).
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) return reject(new Error('aborted'))
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
      },
    } as any,
    runSessions: new RunSessionRegistry(),
    resumableRuns: opts.resumableRuns,
  })

  const server = app.listen(0)
  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, release }
}

describe('registerChatRoutes — resumable runs (detach/reattach)', () => {
  let harness: Harness | null = null
  afterEach(async () => {
    if (!harness) return
    harness.release()
    const server = harness.server
    harness = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('a client disconnect DETACHES (not aborts); reconnecting by streamId replays + finishes the run', async () => {
    harness = startServer({ resumableRuns: true, mode: 'gated' })
    const { baseUrl } = harness

    // Client A starts the run, reads the two pre-gate events, then disconnects.
    const acA = new AbortController()
    const resA = await fetch(`${baseUrl}/api/conversations/c1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', streamId: 's-1' }),
      signal: acA.signal,
    })
    const aEvents = await collect(resA, 2) // started + chunk 'a'
    expect(aEvents.map(e => e.type)).toEqual(['started', 'chunk'])
    acA.abort() // simulate reload / disconnect
    await delay(50) // let the server observe res 'close' and detach

    // Client B reconnects by streamId and drains to the end.
    const resB = await fetch(`${baseUrl}/api/streams/s-1?fromSeq=0`)
    expect(resB.status).toBe(200)
    const bPromise = collect(resB)
    harness.release() // the run (still alive!) emits chunk 'b' + complete
    const bEvents = await bPromise

    // B saw the replayed prefix AND the post-detach tail — proof the run kept running.
    expect(bEvents.map(e => e.type)).toEqual(['started', 'chunk', 'chunk', 'complete'])
    expect(bEvents.filter(e => e.type === 'chunk').map(e => e.delta)).toEqual(['a', 'b'])
    // Every frame carries a monotonic seq for cursor-based replay.
    expect(bEvents.map(e => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('reconnecting with a fromSeq cursor replays only newer frames', async () => {
    harness = startServer({ resumableRuns: true, mode: 'gated' })
    const { baseUrl } = harness

    const acA = new AbortController()
    const resA = await fetch(`${baseUrl}/api/conversations/c1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', streamId: 's-2' }),
      signal: acA.signal,
    })
    await collect(resA, 2)
    acA.abort()
    await delay(50)

    // Resume from seq 1 (already applied 'started') => should NOT replay seq 1.
    const resB = await fetch(`${baseUrl}/api/streams/s-2?fromSeq=1`)
    const bPromise = collect(resB)
    harness.release()
    const bEvents = await bPromise
    expect(bEvents.map(e => e.seq)).toEqual([2, 3, 4]) // chunk a (replayed), chunk b, complete
  })

  it('POST /api/streams/:id/abort is the only thing that cancels a live run', async () => {
    harness = startServer({ resumableRuns: true, mode: 'abortable' })
    const { baseUrl } = harness

    const resC = await fetch(`${baseUrl}/api/conversations/c1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi', streamId: 's-3' }),
    })
    const cPromise = collect(resC)
    await delay(30) // let 'started' flush and the run reach its await

    const abortRes = await fetch(`${baseUrl}/api/streams/s-3/abort`, { method: 'POST' })
    expect(abortRes.status).toBe(200)
    expect(await abortRes.json()).toEqual({ success: true })

    const cEvents = await cPromise
    expect(cEvents[0].type).toBe('started')
    expect(cEvents[cEvents.length - 1].type).toBe('error') // aborted run surfaces a terminal error
  })

  it('GET /api/streams/:id for an unknown stream returns 410 Gone', async () => {
    harness = startServer({ resumableRuns: true, mode: 'gated' })
    const res = await fetch(`${harness.baseUrl}/api/streams/does-not-exist`)
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ gone: true })
  })

  it('with the flag OFF the detach/reattach routes report 501 and disconnect still aborts', async () => {
    harness = startServer({ resumableRuns: false, mode: 'gated' })
    const { baseUrl } = harness

    const getRes = await fetch(`${baseUrl}/api/streams/whatever`)
    expect(getRes.status).toBe(501)
    const abortRes = await fetch(`${baseUrl}/api/streams/whatever/abort`, { method: 'POST' })
    expect(abortRes.status).toBe(501)
  })
})
