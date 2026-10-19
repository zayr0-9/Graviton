import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { registerBrowserUiRoutes } from '../routes/browserUiRoutes.js'

let server: Server | undefined
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
})
