import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../utils/api', () => ({
  buildCachedLocalWebSocketUrl: () => 'ws://localhost/ide-context',
  buildLocalApiUrl: (path: string) => path,
  refreshLocalServerStatus: async () => {},
}))

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('delivers pushed watcher completions once across reconnect replay', async () => {
  const sockets: any[] = []
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    onopen?: () => void
    onmessage?: (event: any) => void
    onclose?: () => void
    send = vi.fn()
    close() { this.readyState = 3 }
    constructor() { sockets.push(this) }
  }
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, jobs: [] }) }))
  const { toolJobManager } = await import('./ToolJobManager')
  const listener = vi.fn()
  const unsubscribe = toolJobManager.onWatchCompletion(listener)
  await toolJobManager.initialize()
  const socket = sockets[0]
  socket.readyState = 1
  socket.onopen()
  expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe_jobs' }))
  const completion = { handle: 'watch-id', state: 'triggered', kind: 'process_exit', conversationId: 'chat', lineageId: 'branch', messageId: 'message', projectId: null, completedAt: new Date().toISOString() }
  const message = { data: JSON.stringify({ type: 'watch_completion', data: completion }) }
  socket.onmessage(message)
  socket.onmessage(message)
  expect(listener).toHaveBeenCalledTimes(1)
  expect(listener).toHaveBeenCalledWith(completion)
  unsubscribe()
  socket.onmessage({ data: JSON.stringify({ type: 'watch_completion', data: { ...completion, handle: 'next' } }) })
  expect(listener).toHaveBeenCalledTimes(1)
})
