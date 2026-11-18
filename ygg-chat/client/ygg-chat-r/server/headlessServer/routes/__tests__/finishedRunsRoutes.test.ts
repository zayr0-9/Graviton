import express from 'express'
import { afterEach, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerChatRoutes } from '../chatRoutes.js'
import { RunSessionRegistry } from '../../services/runSessionRegistry.js'

let server: Server | undefined
afterEach(async () => { if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()) }) })

it('lists finished main runs and serves their current rows without the earlier parent', async () => {
  const sessions = new RunSessionRegistry({ policy: { terminalLingerMs: 1 } })
  const session = sessions.create('s1', 'c')
  session.setSnapshotProvider(() => ({}) as never)
  session.setTranscriptProvider(() => ({ messageIds: ['prior', 'user', 'answer', 'deleted'], excludedParentId: 'prior' }))
  session.publish({ type: 'started', operation: 'send', conversationId: 'c', parentId: 'prior', lineageId: 'l', provider: 'p', modelName: 'm' } as never)
  session.publish({ type: 'complete', message: { id: 'answer' } } as never)
  sessions.reap(Number.MAX_SAFE_INTEGER)
  const rows: Record<string, unknown> = { prior: { id: 'prior' }, user: { id: 'user' }, answer: { id: 'answer' } }
  const reads: Array<[string, string[]]> = []

  const app = express()
  registerChatRoutes(app, { orchestrator: {} as never, runSessions: sessions, resumableRuns: true,
    readRunMessages: (conversationId, ids) => { reads.push([conversationId, ids]); return ids.map(id => rows[id]).filter(Boolean) } })
  server = app.listen(0)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const finished = await (await fetch(`${origin}/api/host/runs/finished`)).json()
  expect(finished.runs).toEqual([expect.objectContaining({ streamId: 's1', conversationId: 'c', lineageId: 'l', status: 'completed' })])
  const transcript = await (await fetch(`${origin}/api/host/runs/s1/transcript`)).json()
  expect(transcript).toEqual({ streamId: 's1', conversationId: 'c', messages: [{ id: 'user' }, { id: 'answer' }] })
  expect(reads).toEqual([['c', ['user', 'answer', 'deleted']]])
  expect((await fetch(`${origin}/api/host/runs/unknown/transcript`)).status).toBe(404)
})
