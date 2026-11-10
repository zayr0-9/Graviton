import express from 'express'
import { createServer, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { registerYggHookGenerateRoute } from '../ephemeralGenerateRoutes.js'
import { HookGenerationService } from '../../services/hookGenerationService.js'

let server: Server | undefined
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }; server = undefined })
async function setup(service: HookGenerationService) {
  const app = express(); app.use(express.json()); registerYggHookGenerateRoute(app, service)
  server = createServer(app)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as any).port}/api/headless/ygg-hooks`
}
it('returns resolved host provider metadata and ignores legacy hints/credential fields', async () => {
  const claude = vi.fn(async () => ({ text: '{}', modelName: 'native' }))
  const openAi = vi.fn()
  const url = await setup(new HookGenerationService({ preferences: () => ({ provider: 'claudecode', claudeModel: '', openAiModel: 'gpt-6-luna' }),
    openAiStatus: () => { throw new Error('OpenAI auth is broken; explicit Claude must not touch it') }, openAi, claude }))
  const response = await fetch(`${url}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'note', provider: 'openai', modelName: 'old', accessToken: 'ignored' }) })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ success: true, provider: 'claudecode', text: '{}', modelName: 'native' })
  expect(openAi).not.toHaveBeenCalled()
  expect(claude.mock.calls[0][0]).not.toHaveProperty('accessToken')
})
it('reports safe provider errors without fallback and rejects invalid requests before generation', async () => {
  const openAi = vi.fn(async () => { throw new Error('private token and prompt') })
  const claude = vi.fn()
  const url = await setup(new HookGenerationService({ preferences: () => ({ provider: 'auto', claudeModel: '', openAiModel: 'gpt-6-luna' }), openAiStatus: () => 'ready', openAi, claude }))
  const send = (payload: any) => fetch(`${url}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  expect((await send({ content: '' })).status).toBe(400)
  const response = await send({ content: 'note' })
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain('private')
  expect(openAi).toHaveBeenCalledOnce(); expect(claude).not.toHaveBeenCalled()
})
it('aborts underlying generation when the HTTP caller disconnects', async () => {
  let signal: AbortSignal | undefined
  const openAi = vi.fn((input: any) => {
    signal = input.signal
    return new Promise<any>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  const url = await setup(new HookGenerationService({ preferences: () => ({ provider: 'openaichatgpt', claudeModel: '', openAiModel: 'gpt-6-luna' }), openAiStatus: () => 'ready', openAi }))
  const controller = new AbortController()
  const request = fetch(`${url}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'note' }), signal: controller.signal }).catch(() => undefined)
  await vi.waitFor(() => expect(signal).toBeDefined())
  controller.abort()
  await request
  await vi.waitFor(() => expect(signal!.aborted).toBe(true))
})
