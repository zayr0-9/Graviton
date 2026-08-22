import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerLineageRoutes } from '../lineageRoutes.js'

describe('local lineage routes', () => {
  let server: Server
  let baseUrl: string
  const reconcileLegacyConversation = vi.fn()
  const list = vi.fn()
  const getDetail = vi.fn()
  const listRecent = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    const app = express()
    registerLineageRoutes(app, {
      db: {} as any,
      statements: {
        getConversationById: { get: (id: string) => id === 'c1' ? { id, user_id: 'u1' } : undefined },
        getProjectById: { get: (id: string) => id === 'p1' ? { id, user_id: 'u1' } : undefined },
      },
      repo: { reconcileLegacyConversation, list, getDetail, listRecent },
    })
    server = app.listen(0)
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => new Promise<void>(resolve => server.close(() => resolve())))

  it('reconciles before listing and validates optional user ownership', async () => {
    list.mockReturnValue([{ id: 'l1' }])
    const response = await fetch(`${baseUrl}/api/gw/conversations/c1/lineages?userId=u1`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: 'l1' }])
    expect(reconcileLegacyConversation).toHaveBeenCalledWith('c1')
    expect(reconcileLegacyConversation.mock.invocationCallOrder[0]).toBeLessThan(list.mock.invocationCallOrder[0])

    expect((await fetch(`${baseUrl}/api/gw/conversations/c1/lineages?userId=other`)).status).toBe(404)
  })

  it('returns resolved lineage detail and prevents cross-conversation misses', async () => {
    getDetail.mockReturnValue({ id: 'l1', pathMessageIds: ['m1', 'm2'], path: [{ id: 'm1' }, { id: 'm2' }] })
    const response = await fetch(`${baseUrl}/api/gw/conversations/c1/lineages/l1`)
    expect(await response.json()).toMatchObject({ pathMessageIds: ['m1', 'm2'] })
    expect(getDetail).toHaveBeenCalledWith('c1', 'l1')

    getDetail.mockReturnValue(null)
    expect((await fetch(`${baseUrl}/api/gw/conversations/c1/lineages/missing`)).status).toBe(404)
  })

  it('clamps recent limits and validates project ownership', async () => {
    listRecent.mockReturnValue([{ lineageId: 'l1', activeRunCount: 2, pathPreview: [] }])
    const response = await fetch(`${baseUrl}/api/gw/projects/p1/recent-lineages?limit=999&userId=u1`)
    expect(response.status).toBe(200)
    expect(listRecent).toHaveBeenCalledWith('p1', 100, 'u1')
    expect((await fetch(`${baseUrl}/api/gw/projects/p1/recent-lineages?userId=u2`)).status).toBe(404)
  })
})
