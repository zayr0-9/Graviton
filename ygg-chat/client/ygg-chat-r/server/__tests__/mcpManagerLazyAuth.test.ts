import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpManager } from '../mcp/mcpManager.js'
import { mcpOAuthSecretStore } from '../mcp/mcpOAuthSecrets.js'

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

  async function configured(oauth?: Record<string, unknown>, credentialStorage?: string) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-mcp-vault-'))
    tempDirs.push(dataDir)
    await fs.writeFile(path.join(dataDir, 'mcp-servers.json'), JSON.stringify({ servers: {
      remote: { enabled: true, transport: 'http', url: 'https://mcp.example.test/mcp', oauth, credentialStorage },
      disabled: { enabled: false, transport: 'http', url: 'https://disabled.test/mcp', oauth: { clientId: 'client' } },
    } }))
    const manager = new McpManager()
    managers.push(manager)
    vi.spyOn(manager, 'getConfigDirectory').mockReturnValue(dataDir)
    await manager.initialize()
    return manager
  }

  it('does not hydrate disabled servers', async () => {
    const load = vi.spyOn(mcpOAuthSecretStore, 'load').mockResolvedValue({})
    const manager = await configured()
    await expect(manager.callServerTool('disabled', 'echo', {})).rejects.toThrow('disabled')
    expect(load).not.toHaveBeenCalled()
  })

  it('fails closed on denied vault access even without OAuth metadata', async () => {
    vi.spyOn(mcpOAuthSecretStore, 'load').mockRejectedValue(new Error('denied'))
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const manager = await configured(undefined, 'vault')
    await expect(manager.callServerTool('remote', 'echo', {})).rejects.toThrow('denied')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the server configuration when credential deletion fails', async () => {
    vi.spyOn(mcpOAuthSecretStore, 'clear').mockRejectedValue(new Error('denied'))
    const manager = await configured({ clientId: 'client' }, 'vault')
    await expect(manager.removeServer('remote')).rejects.toThrow('denied')
    expect((await manager.getConfigs()).some(config => config.name === 'remote')).toBe(true)
  })

  it('does not strip legacy plaintext on an unrelated metadata-only save', async () => {
    const save = vi.spyOn(mcpOAuthSecretStore, 'save').mockResolvedValue()
    const manager = await configured({ clientId: 'client', refreshToken: 'legacy-refresh' })
    await manager.updateServer('remote', { autoStart: false })
    const text = await fs.readFile(manager.getConfigPath(), 'utf8')
    expect(JSON.parse(text).servers.remote.oauth.refreshToken).toBe('legacy-refresh')
    expect(save).not.toHaveBeenCalled()
  })

  it('imports plaintext without replacing a newer vault credential', async () => {
    const imported = vi.spyOn(mcpOAuthSecretStore, 'importLegacy').mockResolvedValue()
    const save = vi.spyOn(mcpOAuthSecretStore, 'save').mockResolvedValue()
    vi.spyOn(mcpOAuthSecretStore, 'load').mockResolvedValue({ refreshToken: 'rotated-refresh' })
    const manager = await configured({ clientId: 'client', refreshToken: 'stale-refresh' })
    await manager.consolidatePlaintextCredentials()
    expect(imported).toHaveBeenCalledWith('remote', expect.objectContaining({ refreshToken: 'stale-refresh' }))
    expect(save).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(manager.getConfigPath(), 'utf8')).servers.remote.oauth).not.toHaveProperty('refreshToken')
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
          oauth: { clientId: 'client' },
        },
      },
    }))

    const loadSecrets = vi.spyOn(mcpOAuthSecretStore, 'load').mockResolvedValue({ accessToken: 'saved-token' })
    const saveSecrets = vi.spyOn(mcpOAuthSecretStore, 'save').mockResolvedValue()
    const clearSecrets = vi.spyOn(mcpOAuthSecretStore, 'clear').mockResolvedValue()
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

    await manager.getConfigs()
    await manager.updateServer('remote', { autoStart: false })
    expect(loadSecrets).not.toHaveBeenCalled()
    expect(saveSecrets).not.toHaveBeenCalled()
    expect(clearSecrets).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(manager.getStatus()).toEqual([])
    expect(manager.getSettings()).toEqual({ lazyStart: true })

    const [result] = await Promise.all([
      manager.callTool('mcp__remote__echo', { value: 'hello' }),
      manager.callTool('mcp__remote__echo', { value: 'concurrent' }),
    ])

    expect(result.content[0]?.text).toBe('ok')
    expect(loadSecrets).toHaveBeenCalledTimes(1)
    expect(loadSecrets).toHaveBeenCalledWith('remote', true)
    expect(saveSecrets).not.toHaveBeenCalled()
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer saved-token')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    expect(manager.getServerStatus('remote')?.status).toBe('connected')
    expect(toolsChanged).toHaveBeenCalledWith(expect.objectContaining({
      serverName: 'remote',
      tools: [expect.objectContaining({ name: 'echo', qualifiedName: 'mcp__remote__echo' })],
    }))
  })
})
