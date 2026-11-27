import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { request, type Server } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { jsonCompressionMiddleware, JSON_COMPRESSION_MIN_BYTES } from '../responseCompression.js'

let server: Server | undefined

// Node's fetch adds `Cache-Control: no-cache` to any request given If-None-Match by hand, which
// rightly disables freshness. Browsers revalidate from their cache without it; mimic that raw.
const conditional = (url: string, etag: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request(url, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etag } }, res => {
    const chunks: Buffer[] = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => {
      const raw = Buffer.concat(chunks)
      resolve({ status: res.statusCode ?? 0, body: (raw.length > 0 && res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8') })
    })
  })
  req.on('error', reject)
  req.end()
})
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
})

const large = { rows: Array.from({ length: 400 }, (_, index) => ({ index, text: 'tool output '.repeat(10) })) }
const huge = { rows: Array.from({ length: 4000 }, (_, index) => ({ index, text: 'tool output '.repeat(20) })) }

async function start() {
  const app = express()
  app.use(jsonCompressionMiddleware)
  app.get('/small', (_req, res) => res.json({ ok: true }))
  app.get('/large', (_req, res) => res.json(large))
  app.get('/huge', (_req, res) => res.json(huge))
  app.get('/error', (_req, res) => res.status(404).json({ error: 'missing' }))
  app.get('/sse', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: {}\n\n'); res.end() })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server!.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

describe('JSON response compression', () => {
  it('gzips large bodies for clients that accept it, synchronously and through the thread pool, without changing the decoded JSON', async () => {
    const origin = await start()
    expect(JSON.stringify(large).length).toBeGreaterThan(JSON_COMPRESSION_MIN_BYTES)
    for (const [path, payload] of [['/large', large], ['/huge', huge]] as const) {
      const response = await fetch(origin + path, { headers: { 'Accept-Encoding': 'gzip' } })
      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('vary')).toContain('Accept-Encoding')
      expect(Number(response.headers.get('content-length'))).toBeLessThan(JSON.stringify(payload).length / 4)
      expect(await response.json()).toEqual(payload)
    }
  })

  it('leaves small bodies, error bodies, identity clients and non-JSON responses alone', async () => {
    const origin = await start()
    const small = await fetch(origin + '/small', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(small.headers.get('content-encoding')).toBeNull()
    expect(await small.json()).toEqual({ ok: true })
    const error = await fetch(origin + '/error', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(error.status).toBe(404)
    expect(await error.json()).toEqual({ error: 'missing' })
    const identity = await fetch(origin + '/large', { headers: { 'Accept-Encoding': 'identity' } })
    expect(identity.headers.get('content-encoding')).toBeNull()
    expect(await identity.json()).toEqual(large)
    const sse = await fetch(origin + '/sse')
    expect(sse.headers.get('content-encoding')).toBeNull()
    expect(await sse.text()).toBe('data: {}\n\n')
  })

  it('answers a matching If-None-Match with 304 on the compressed representation', async () => {
    const origin = await start()
    const first = await fetch(origin + '/huge', { headers: { 'Accept-Encoding': 'gzip' } })
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const again = await conditional(origin + '/huge', etag!)
    expect(again.status).toBe(304)
    expect(again.body).toBe('')
    expect((await conditional(origin + '/huge', 'W/"stale"')).status).toBe(200)
    // The raw bytes really are gzip, so a client without automatic decoding can inflate them.
    const raw = await fetch(origin + '/large', { headers: { 'Accept-Encoding': 'gzip' }, decompress: false } as RequestInit)
    const bytes = Buffer.from(await raw.arrayBuffer())
    if (raw.headers.get('content-encoding') === 'gzip' && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      expect(JSON.parse(gunzipSync(bytes).toString('utf8'))).toEqual(large)
    } else {
      expect(JSON.parse(bytes.toString('utf8'))).toEqual(large)
    }
  })
})
