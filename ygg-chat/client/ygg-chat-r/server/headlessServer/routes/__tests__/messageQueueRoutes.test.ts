import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerChatRoutes } from '../chatRoutes.js'
import { RunSessionRegistry } from '../../services/runSessionRegistry.js'

let server: Server | undefined
afterEach(async () => { if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()) }) })
const setup = (orchestrator: any) => {
  const app = express(); app.use(express.json())
  const sessions = new RunSessionRegistry()
  registerChatRoutes(app, { orchestrator, runSessions: sessions, resumableRuns: true })
  server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversations/c/streams/s/queue`
  return { base, sessions }
}
const post = (base: string, body: any) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('message queue routes', () => {
  it('queues and cancels without starting another run; rejects invalid payloads and cross-conversation ownership', async () => {
    const runMessage = vi.fn()
    const snapshot = { streamId: 's', conversationId: 'c', lineageId: 'l', revision: 1, items: [] }
    const { base } = setup({ runMessage,
      submitQueuedMessage: (conversation: string) => { if (conversation !== 'c') throw new Error('wrong conversation'); return { snapshot } },
      getMessageQueue: () => snapshot, cancelQueuedMessage: () => snapshot,
    })
    expect((await post(base, { requestId: 'q', content: 'follow up' })).status).toBe(200)
    expect(runMessage).not.toHaveBeenCalled()
    expect(await (await fetch(base)).json()).toEqual(snapshot)
    expect((await fetch(`${base}/q`, { method: 'DELETE' })).status).toBe(200)
    expect((await post(base, { content: '' })).status).toBe(400)
    expect((await post(base.replace('/c/', '/other/'), { requestId: 'q', content: 'follow up' })).status).toBe(409)
  })

  it('starts a server-owned successor on the completion race and exposes it for reattach', async () => {
    const request = { operation: 'send', streamId: 'next', conversationId: 'c', parentId: 'final', content: 'follow up', provider: 'openaichatgpt', modelName: 'test' }
    const runMessage = vi.fn(async (_request, emit) => { emit({ type: 'complete', message: { id: 'answer' } }) })
    const { base, sessions } = setup({ runMessage, submitQueuedMessage: () => ({ restart: request }) })
    const response = await post(base, { requestId: 'q', content: 'follow up' })
    expect(await response.json()).toEqual({ restarted: true, streamId: 'next', parentId: 'final' })
    expect(runMessage).toHaveBeenCalledTimes(1)
    expect(sessions.get('next')?.status).toBe('completed')
  })
})
