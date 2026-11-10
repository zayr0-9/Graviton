import express from 'express'
import { expect, it } from 'vitest'
import { opaqueMutationFence, getNativeClientFence, nativeClientHeader } from '../nativeClientFence.js'
it('blocks opaque app mutations across legacy APIs but preserves native session and same-origin clients', async () => {
  const app = express(); app.use('/api', opaqueMutationFence)
  app.post('/api/jobs', (_req, res) => res.json({ success: true }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/jobs`
  try {
    expect((await fetch(url, { method: 'POST', headers: { origin: 'null' } })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: { origin: 'null', [nativeClientHeader]: 'forged' } })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: { origin: 'null', [nativeClientHeader]: getNativeClientFence() } })).status).toBe(200)
    expect((await fetch(url, { method: 'POST' })).status).toBe(200)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
