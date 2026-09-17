import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpManager } from '../mcp/mcpManager.js'

const jsonRpcResponse = (request: { id: number; method: string }) => {
  switch (request.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'test-server' } } }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }],
        },
      }
    case 'resources/list':
      return { jsonrpc: '2.0', id: request.id, result: { resources: [] } }
    case 'prompts/list':
      return { jsonrpc: '2.0', id: request.id, result: { prompts: [] } }
    case 'tools/call':
      return { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }] } }
    default:
      throw new Error(`Unexpected MCP method: ${request.method}`)
  }
}

describe('McpManager lazy connection', () => {
  const managers: McpManager[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.shutdown()))
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not connect or authenticate at startup and connects on first MCP tool call', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-mcp-lazy-'))
    tempDirs.push(dataDir)
    await fs.writeFile(path.join(dataDir, 'mcp-servers.json'), JSON.stringify({
      settings: { lazyStart: false },
      servers: {
        remote: {
          enabled: true,
          autoStart: true,
          transport: 'http',
          url: 'https://mcp.example.test/mcp',
        },
      },
    }))

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (request.id === undefined) return new Response(null, { status: 202 })
      return new Response(JSON.stringify(jsonRpcResponse(request as { id: number; method: string })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const manager = new McpManager()
    managers.push(manager)
    vi.spyOn(manager, 'getConfigDirectory').mockReturnValue(dataDir)
    const toolsChanged = vi.fn()
    manager.on('toolsChanged', toolsChanged)

    await manager.initialize()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(manager.getStatus()).toEqual([])
    expect(manager.getSettings()).toEqual({ lazyStart: true })

    const result = await manager.callTool('mcp__remote__echo', { value: 'hello' })

    expect(result.content[0]?.text).toBe('ok')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    expect(manager.getServerStatus('remote')?.status).toBe('connected')
    expect(toolsChanged).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'remote',
      tools: [expect.objectContaining({ name: 'echo', qualifiedName: 'mcp__remote__echo' })],
    }))
  })
})
