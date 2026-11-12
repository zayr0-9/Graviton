import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpManager } from '../mcp/mcpManager.js'
import { mcpOAuthSecretStore } from '../mcp/mcpOAuthSecrets.js'
import { configureServerHost, resetServerHost } from '../serverHost.js'

describe('explicit MCP reauthentication', () => {
  let manager: McpManager
  let directory: string
  afterEach(async () => {
    await manager?.shutdown()
    if (directory) await fs.rm(directory, { recursive: true, force: true })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetServerHost()
  })

  async function fixture(overrides: Record<string, unknown> = {}) {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-reauth-'))
    const oauth = { clientId: 'configured-client', tokenEndpointAuthMethod: 'client_secret_post',
      tokenEndpoint: 'https://issuer.test/token', scopes: ['openid'], expiresAt: Date.now() + 600000 }
    await fs.writeFile(path.join(directory, 'mcp-servers.json'), JSON.stringify({ servers: {
      remote: { enabled: true, transport: 'http', url: 'https://mcp.test/mcp', credentialStorage: 'vault', oauth, ...overrides },
      other: { enabled: true, transport: 'http', url: 'https://other.test/mcp', credentialStorage: 'vault' },
    } }))
    let credentials = { accessToken: 'rejected', refreshToken: 'stale-refresh', clientSecret: 'keep-secret' } as Record<string, string | undefined>
    vi.spyOn(mcpOAuthSecretStore, 'load').mockImplementation(async () => ({ ...credentials }))
    const patch = vi.spyOn(mcpOAuthSecretStore, 'patch').mockImplementation(async (_name, updates) => { credentials = { ...credentials, ...updates } })
    vi.spyOn(mcpOAuthSecretStore, 'save').mockImplementation(async (_name, updates) => { credentials = { ...updates } })
    const realFetch = globalThis.fetch
    const grants: string[] = []
    const rpcTokens: string[] = []
    let rejectRpc = false
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.hostname === '127.0.0.1') return realFetch(input, init)
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
      if (url.pathname.includes('oauth-protected-resource')) return json({ resource: 'https://mcp.test/mcp', authorization_servers: ['https://issuer.test'] })
      if (url.pathname.includes('oauth-authorization-server')) return json({ authorization_endpoint: 'https://issuer.test/authorize', token_endpoint: 'https://issuer.test/token', code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] })
      if (url.pathname === '/token') {
        const body = new URLSearchParams(String(init?.body))
        grants.push(body.get('grant_type')!)
        expect(body.get('client_secret')).toBe('keep-secret')
        return json({ access_token: 'fresh', refresh_token: 'fresh-refresh', expires_in: 3600 })
      }
      rpcTokens.push(new Headers(init?.headers).get('authorization') || '')
      if (rejectRpc) return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
      const request = JSON.parse(String(init?.body))
      const result = request.method === 'initialize' ? { serverInfo: { name: 'test' } }
        : request.method === 'tools/list' ? { tools: [] } : request.method === 'resources/list' ? { resources: [] } : { prompts: [] }
      return request.id == null ? new Response('', { status: 202 }) : json({ jsonrpc: '2.0', id: request.id, result })
    })
    let releaseBrowser!: () => void
    const openExternal = vi.fn(async (url: string) => {
      const auth = new URL(url)
      releaseBrowser = () => { void realFetch(`${auth.searchParams.get('redirect_uri')}?code=test-code&state=${auth.searchParams.get('state')}`) }
    })
    configureServerHost({
      bindHost: '127.0.0.1', preferredPort: 0, fallbackPorts: [], allowEphemeralPort: true,
      dataDir: directory, tempDir: directory, dbPath: path.join(directory, 'test.db'), resourcesDir: directory,
      cors: { mode: 'loopback', allowedOrigins: [] }, oauth: { enabled: false, callbackHost: '127.0.0.1', callbackPort: 1455 },
      toolRuntime: { mode: 'local', allowInProcessFallback: false }, allowNonLoopbackBind: false,
    }, {
      configStore: { get: () => undefined, set: () => undefined, delete: () => undefined },
      secretStore: { getSecret: async () => null, setSecret: async () => undefined, deleteSecret: async () => undefined },
      toolSandbox: null, openExternal,
    })
    manager = new McpManager()
    await manager.initialize()
    return { patch, grants, rpcTokens, openExternal, release: () => releaseBrowser(), credentials: () => credentials,
      rejectRpc: () => { rejectRpc = true } }
  }

  it('bypasses stored access/refresh tokens, preserves client secret and coalesces concurrent sign-ins', async () => {
    const f = await fixture()
    const first = manager.reauthenticateServer('remote')
    const second = manager.reauthenticateServer('remote')
    await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledOnce())
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'connecting', phase: 'authorizing' })
    expect(f.patch).toHaveBeenCalledOnce()
    expect(f.patch).toHaveBeenCalledWith('remote', { accessToken: undefined, refreshToken: undefined })
    expect(f.grants).toEqual([])
    const pendingConfig = (await manager.getConfigs()).find(c => c.name === 'remote')!
    expect(pendingConfig.oauth).toMatchObject({ clientId: 'configured-client', scopes: ['openid'] })
    expect(pendingConfig.oauth?.expiresAt).toBeUndefined()
    f.release()
    await Promise.all([first, second])
    expect(f.grants).toEqual(['authorization_code'])
    expect(f.rpcTokens.every(token => token === 'Bearer fresh')).toBe(true)
    expect(f.credentials()).toMatchObject({ accessToken: 'fresh', refreshToken: 'fresh-refresh', clientSecret: 'keep-secret' })
    expect(manager.getServerStatus('remote')?.status).toBe('connected')
    expect(manager.getServerStatus('other')).toBeUndefined()
  })

  it('cancels pending browser authorization and permits another fresh sign-in', async () => {
    const f = await fixture()
    const first = manager.reauthenticateServer('remote').catch(error => error)
    await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledOnce())
    await manager.stopServer('remote')
    expect(await first).toBeInstanceOf(Error)
    const next = manager.reauthenticateServer('remote')
    await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledTimes(2))
    f.release()
    await next
    expect(manager.getServerStatus('remote')?.status).toBe('connected')
  })

  it.each([
    [{ transport: 'stdio', command: 'test' }, 'HTTP'],
    [{ enabled: false }, 'disabled'],
    [{ headers: { authorization: 'Bearer static' } }, 'static Authorization'],
  ])('rejects unsupported configurations without clearing credentials: %j', async (overrides, message) => {
    const f = await fixture(overrides)
    await expect(manager.reauthenticateServer('remote')).rejects.toThrow(message)
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.openExternal).not.toHaveBeenCalled()
  })

  it('persists rejected tokens and gives a reauthentication action after refresh is also rejected', async () => {
    const f = await fixture()
    f.rejectRpc()
    const config = (await manager.getConfigs()).find(c => c.name === 'remote')!
    await expect(manager.startServer(config)).rejects.toThrow('action="reauthenticate"')
    expect(f.grants).toEqual(['refresh_token'])
    expect(f.rpcTokens).toEqual(['Bearer rejected', 'Bearer fresh'])
    expect(f.credentials().accessToken).toBeUndefined()
    expect(f.credentials().refreshToken).toBe('fresh-refresh')
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(mcpOAuthSecretStore.save).toHaveBeenCalledWith('remote', expect.objectContaining({ accessToken: undefined }))
  })

  it('still opens the browser if tokens reappear during vault hydration', async () => {
    const f = await fixture()
    vi.mocked(mcpOAuthSecretStore.load).mockResolvedValue({ accessToken: 'concurrent-token', refreshToken: 'concurrent-refresh', clientSecret: 'keep-secret' })
    const operation = manager.reauthenticateServer('remote')
    await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledOnce())
    expect(f.grants).toEqual([])
    f.release()
    await operation
    expect(f.grants).toEqual(['authorization_code'])
  })

  it('honors Stop while initial configuration validation is pending', async () => {
    const f = await fixture()
    const configs = await manager.getConfigs()
    let release!: (value: typeof configs) => void
    vi.spyOn(manager, 'getConfigs').mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const operation = manager.reauthenticateServer('remote')
    await manager.stopServer('remote')
    release(configs)
    await expect(operation).rejects.toThrow('cancelled')
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.openExternal).not.toHaveBeenCalled()
  })

  it('revalidates configuration inside the reset lock', async () => {
    const f = await fixture()
    const original = await manager.getConfigs()
    // Simulate another host changing the persisted config after the first snapshot.
    await fs.writeFile(path.join(directory, 'mcp-servers.json'), JSON.stringify({ servers: {
      remote: { ...original[0], enabled: false },
    } }))
    vi.spyOn(manager, 'getConfigs').mockResolvedValueOnce(original)
    await expect(manager.reauthenticateServer('remote')).rejects.toThrow('disabled')
    expect(f.patch).not.toHaveBeenCalled()
  })

  it('does not launch sign-in if Stop arrives during a secure-store reset', async () => {
    const f = await fixture()
    let release!: () => void
    f.patch.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve }))
    const operation = manager.reauthenticateServer('remote').catch(error => error)
    await vi.waitFor(() => expect(f.patch).toHaveBeenCalledOnce())
    await manager.stopServer('remote')
    release()
    expect(await operation).toBeInstanceOf(Error)
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(manager.getServerStatus('remote')).toBeUndefined()
  })

  it('fails closed when credential reset is denied', async () => {
    const f = await fixture()
    f.patch.mockRejectedValue(new Error('Keychain denied'))
    await expect(manager.reauthenticateServer('remote')).rejects.toThrow('Keychain denied')
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'error', error: 'Keychain denied' })
  })
})
