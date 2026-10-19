import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../utils/api', () => ({ buildLocalApiUrl: async (path: string) => `http://host/api${path}` }))
vi.mock('../helpers/fullAccessSettings', () => ({ isFullAccessEnabled: () => false }))
import { createHostAppClient } from './hostAppClient'
afterEach(() => vi.unstubAllGlobals())
it('serializes app calls and retries uncertain delivery with one immutable command', async () => {
  vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  const calls: any[] = []
  let commandAttempts = 0
  const fetcher = vi.fn(async (url: string, options: any) => {
    calls.push([url, options])
    if (url.endsWith('/sessions')) return new Response(JSON.stringify({ id: 'session' }))
    if (++commandAttempts === 1) throw new Error('Lost acknowledgement')
    return new Response(JSON.stringify({ success: true }))
  })
  vi.stubGlobal('fetch', fetcher)
  const client = createHostAppClient(() => ({ rootPath: '/work', mode: 'execute', toolName: 'app' }))
  await client.call('exec.run', { command: 'echo fixture' }, 'request')
  expect(calls.filter(([url]) => url.endsWith('/sessions'))).toHaveLength(1)
  expect(calls[1][1].body).toBe(calls[2][1].body)
  expect(JSON.parse(calls[1][1].body)).toMatchObject({ requestId: 'request', method: 'exec.run' })
  client.dispose()
})
it('stops repeated permission prompts after three denials', async () => {
  const confirm = vi.fn(() => false)
  vi.stubGlobal('window', { confirm }); vi.stubGlobal('fetch', vi.fn())
  const client = createHostAppClient(() => ({ rootPath: '/work' }))
  for (let i = 0; i < 4; i++) await expect(client.call('exec.run', { command: 'no' }, String(i))).rejects.toThrow()
  expect(confirm).toHaveBeenCalledTimes(3)
  expect(fetch).not.toHaveBeenCalled()
})
