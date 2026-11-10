import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSyncStorageRoutes } from '../routes/syncStorageRoutes.js'

// Graviton is fully local: the cloud-mirror /api/sync/* writers are gone and only
// the local attachment endpoints remain on this module.
describe('registerSyncStorageRoutes', () => {
  let appServer: Server
  let baseUrl = ''

  beforeEach(() => {
    const app = express()
    app.use(express.json())
    registerSyncStorageRoutes(app, {
      db: {} as any,
      statements: { getAttachmentById: { get: () => undefined } },
      getCurrentDbPath: () => null,
    })
    appServer = app.listen(0)
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => appServer.close(error => (error ? reject(error) : resolve())))
  })

  it.each([
    ['POST', '/api/sync/user'],
    ['POST', '/api/sync/project'],
    ['POST', '/api/sync/conversation'],
    ['POST', '/api/sync/message'],
    ['POST', '/api/sync/attachment'],
    ['POST', '/api/sync/provider-cost'],
    ['POST', '/api/sync/batch'],
    ['DELETE', '/api/sync/message/m1'],
  ])('no longer registers %s %s', async (method, route) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    })
    expect(response.status).toBe(404)
  })

  it('keeps the local attachment file endpoint', async () => {
    const response = await fetch(`${baseUrl}/api/local/attachments/missing/file`)
    // The route's own JSON 404, not Express's unmatched-route page.
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Attachment not found' })
  })
})
