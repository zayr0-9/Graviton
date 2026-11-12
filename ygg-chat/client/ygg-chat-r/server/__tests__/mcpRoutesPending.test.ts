import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'

const fixture = vi.hoisted(() => {
  const manager = {
    initialize: vi.fn(async () => {}), getConfigs: vi.fn(), getStatus: vi.fn(), getServerStatus: vi.fn(),
    getAllTools: vi.fn(), startServer: vi.fn(), restartServer: vi.fn(), reauthenticateServer: vi.fn(), getStartPhase: vi.fn(), callTool: vi.fn(),
  }
  return { manager, registerTool: vi.fn() }
})
vi.mock('../mcp/mcpManager.js', () => ({ mcpManager: fixture.manager, parseMcpOAuthRedirectUri: vi.fn() }))
vi.mock('../tools/orchestrator/index.js', () => ({ toolOrchestrator: { registerTool: fixture.registerTool } }))

import { registerMcpRoutes } from '../mcp/mcpRoutes.js'

let server: Server | undefined
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
  server = undefined
})
async function start(startResponseBudgetMs = 25) {
  const app = express(); app.use(express.json()); registerMcpRoutes(app, { startResponseBudgetMs })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server!.once('listening', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
const post = (origin: string, path: string) => fetch(`${origin}${path}`, { method: 'POST' })

describe('MCP start routes never hold a request for a sign-in', () => {
  const { manager, registerTool } = fixture
  beforeEach(() => {
    vi.clearAllMocks()
    manager.getConfigs.mockResolvedValue([{ name: 'remote', enabled: true, transport: 'http', url: 'https://mcp.example.test/mcp' }])
    manager.getAllTools.mockReturnValue([{ name: 'echo', qualifiedName: 'mcp__remote__echo' }])
    manager.getStatus.mockReturnValue([])
  })

  it('answers pending with the reason while the connection continues, then registers its tools', async () => {
    let finish!: () => void
    const connecting = new Promise<void>(resolve => { finish = resolve })
    manager.startServer.mockReturnValue(connecting)
    manager.getStartPhase.mockReturnValue('credentials')
    const origin = await start()

    // More parked requests than a browser allows per host (6): all of them return.
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(origin, '/api/mcp/servers/remote/start')))
    expect(responses.map(response => response.status)).toEqual(Array(8).fill(202))
    const body = await responses[0].json()
    expect(body).toMatchObject({ success: true, pending: true, phase: 'credentials' })
    expect(body.message).toMatch(/keychain/i)
    expect(registerTool).not.toHaveBeenCalled()

    finish()
    await vi.waitFor(() => expect(registerTool).toHaveBeenCalledWith('mcp__remote__echo', expect.any(Function)))
  })

  it('answers normally when the server connects inside the budget', async () => {
    manager.startServer.mockResolvedValue(undefined)
    const response = await post(await start(1000), '/api/mcp/servers/remote/start')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ success: true, toolsRegistered: 1 })
    expect(body.pending).toBeUndefined()
  })

  it('still reports a failure that happens inside the budget', async () => {
    manager.startServer.mockRejectedValue(new Error('HTTP 401 Unauthorized'))
    const response = await post(await start(1000), '/api/mcp/servers/remote/start')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ success: false, error: 'HTTP 401 Unauthorized' })
  })

  it('does not crash the host when a pending start fails later', async () => {
    let fail!: (error: Error) => void
    manager.startServer.mockReturnValue(new Promise<void>((_resolve, reject) => { fail = reject }))
    manager.getStartPhase.mockReturnValue('authorizing')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const origin = await start()
      const response = await post(origin, '/api/mcp/servers/remote/start')
      expect(await response.json()).toMatchObject({ pending: true, phase: 'authorizing' })
      fail(new Error('sign-in timed out'))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).not.toHaveBeenCalled()
      expect(registerTool).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('applies the same budget to restart', async () => {
    manager.restartServer.mockReturnValue(new Promise(() => {}))
    manager.getStartPhase.mockReturnValue(undefined)
    const response = await post(await start(), '/api/mcp/servers/remote/restart')
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ success: true, pending: true, phase: 'connecting' })
  })

  it('returns pending for reauthentication and registers tools after sign-in', async () => {
    let finish!: () => void
    manager.reauthenticateServer.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    manager.getStartPhase.mockReturnValue('authorizing')
    const response = await post(await start(), '/api/mcp/servers/remote/reauthenticate')
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ success: true, pending: true, phase: 'authorizing' })
    expect(manager.reauthenticateServer).toHaveBeenCalledWith('remote')
    finish()
    await vi.waitFor(() => expect(registerTool).toHaveBeenCalled())
  })

  it('reports successful and failed reauthentication accurately', async () => {
    const origin = await start(1000)
    manager.reauthenticateServer.mockResolvedValue(undefined)
    expect((await post(origin, '/api/mcp/servers/remote/reauthenticate')).status).toBe(200)
    manager.reauthenticateServer.mockRejectedValue(new Error('Sign-in denied'))
    const response = await post(origin, '/api/mcp/servers/remote/reauthenticate')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ success: false, error: 'Sign-in denied' })
  })

  it('lists what each connecting server is waiting on', async () => {
    manager.getStatus.mockReturnValue([{ name: 'remote', status: 'connecting', phase: 'authorizing', tools: [], resources: [], prompts: [] }])
    const response = await fetch(`${await start()}/api/mcp/servers`)
    const { servers } = await response.json()
    expect(servers[0]).toMatchObject({ name: 'remote', status: 'connecting', phase: 'authorizing' })
    expect(servers[0].phaseMessage).toMatch(/browser/i)
  })
})
