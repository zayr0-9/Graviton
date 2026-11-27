import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { request, type Server } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { registerBrowserUiRoutes } from '../routes/browserUiRoutes.js'

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
let root: string | undefined
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  if (root) rmSync(root, { recursive: true, force: true })
})
async function start(built = true) {
  root = mkdtempSync(path.join(tmpdir(), 'graviton-ui-'))
  if (built) writeFileSync(path.join(root, 'index.html'), '<main>shared app</main>')
  writeFileSync(path.join(root, '.private'), 'not public')
  const app = express()
  registerBrowserUiRoutes(app, root)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server!.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
describe('shared browser static hosting', () => {
  it('serves the built entry without swallowing missing API/assets or dotfiles', async () => {
    const origin = await start()
    const response = await fetch(origin)
    expect(await response.text()).toContain('shared app')
    expect(response.headers.get('cache-control')).toBe('no-store')
    for (const url of ['/api/missing', '/assets/missing.js', '/.private']) {
      expect((await fetch(origin + url)).status).toBe(404)
    }
  })
  it('reports missing build without preventing the API server from starting', async () => {
    const origin = await start(false)
    expect((await fetch(origin)).status).toBe(503)
  })
  it('serves hashed bundles gzipped and immutable, plain to identity clients, and revalidates by ETag', async () => {
    const origin = await start()
    const source = `export const app = ${JSON.stringify('x'.repeat(4096))}\n`
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(path.join(root!, 'assets'))
    writeFileSync(path.join(root!, 'assets', 'index-B4UP0GA1.js'), source)
    writeFileSync(path.join(root!, 'assets', 'plain.css'), 'body{}')
    const gzipped = await fetch(origin + '/assets/index-B4UP0GA1.js', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(gzipped.headers.get('content-encoding')).toBe('gzip')
    expect(gzipped.headers.get('content-type')).toMatch(/javascript; charset=utf-8/)
    expect(gzipped.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(gzipped.headers.get('vary')).toContain('Accept-Encoding')
    expect(Number(gzipped.headers.get('content-length'))).toBeLessThan(source.length / 4)
    expect(await gzipped.text()).toBe(source)
    const etag = gzipped.headers.get('etag')
    expect((await conditional(origin + '/assets/index-B4UP0GA1.js', etag!)).status).toBe(304)
    const plain = await fetch(origin + '/assets/index-B4UP0GA1.js', { headers: { 'Accept-Encoding': 'identity' } })
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await plain.text()).toBe(source)
    const css = await fetch(origin + '/assets/plain.css', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(css.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(await css.text()).toBe('body{}')
    expect((await fetch(origin + '/assets/../.private', { headers: { 'Accept-Encoding': 'gzip' } })).status).toBe(404)
  })
})
