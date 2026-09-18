import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSyncStorageRoutes } from '../routes/syncStorageRoutes.js'

describe('registerSyncStorageRoutes message persistence', () => {
  let appServer: Server
  let baseUrl = ''
  const upsertMessageRun = vi.fn()

  beforeEach(() => {
    upsertMessageRun.mockReset()

    const app = express()
    app.use(express.json())

    const db = {
      prepare(sql: string) {
        if (sql.includes('SELECT user_id, project_id FROM conversations')) {
          return { get: () => ({ user_id: 'u1', project_id: null }) }
        }
        if (sql.includes('SELECT project_id FROM conversations')) {
          return { get: () => ({ project_id: null }) }
        }
        if (sql.includes('SELECT id FROM users') || sql.includes('SELECT id FROM conversations')) {
          return { get: () => ({ id: 'existing' }) }
        }
        return { get: () => undefined, run: () => ({ changes: 1 }) }
      },
    }

    registerSyncStorageRoutes(app, {
      db: db as any,
      statements: {
        upsertMessage: { run: upsertMessageRun },
      },
      getCurrentDbPath: () => null,
    })

    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close(error => (error ? reject(error) : resolve()))
    })
  })

  it('binds the message meta value as the eighteenth upsert parameter', async () => {
    const response = await fetch(`${baseUrl}/api/sync/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'm1',
        conversation_id: 'c1',
        role: 'system',
        content: 'persisted summary',
        children_ids: [],
        content_blocks: [],
        tool_calls: [],
        meta: { kind: 'context_injection' },
      }),
    })

    expect(response.status).toBe(200)
    expect(upsertMessageRun).toHaveBeenCalledTimes(1)
    const parameters = upsertMessageRun.mock.calls[0]
    expect(parameters).toHaveLength(18)
    expect(parameters[17]).toBe(JSON.stringify({ kind: 'context_injection' }))
  })

  it('binds SQL null when message metadata is absent', async () => {
    const response = await fetch(`${baseUrl}/api/sync/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'm2',
        conversation_id: 'c1',
        role: 'system',
        content: 'persisted summary',
      }),
    })

    expect(response.status).toBe(200)
    expect(upsertMessageRun.mock.calls[0]).toHaveLength(18)
    expect(upsertMessageRun.mock.calls[0][17]).toBeNull()
  })
})
