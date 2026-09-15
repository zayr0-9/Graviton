import fs from 'fs/promises'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpOAuthSecretStore } from '../mcp/mcpOAuthSecrets.js'
import { McpManager, parseMcpOAuthRedirectUri } from '../mcp/mcpManager.js'
import { configureServerHost, resetServerHost } from '../serverHost.js'

describe('parseMcpOAuthRedirectUri', () => {
  it.each([
    ['http://127.0.0.1:6274/oauth/callback', '127.0.0.1'],
    ['http://localhost:6274/oauth/callback', 'localhost'],
  ] as const)('accepts fixed loopback callback %s', (redirectUri, hostname) => {
    expect(parseMcpOAuthRedirectUri(redirectUri)).toEqual({
      redirectUri,
      hostname,
      port: 6274,
      pathname: '/oauth/callback',
    })
  })

  it.each([
    'https://127.0.0.1:6274/oauth/callback',
    'http://example.com:6274/oauth/callback',
    'http://0.0.0.0:6274/oauth/callback',
    'http://127.0.0.1/oauth/callback',
    'http://127.0.0.1:6274/oauth/callback?source=ygg',
    'http://127.0.0.1:6274/oauth/callback#complete',
    'not-a-url',
  ])('rejects unsupported callback URI %s', redirectUri => {
    expect(() => parseMcpOAuthRedirectUri(redirectUri)).toThrow(/oauth\.redirectUri/)
  })
})

const listen = async (handler: Parameters<typeof createServer>[0]) => {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

const close = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

describe('MCP OAuth fixed redirect flow', () => {
  const managers: McpManager[] = []
  const servers: Array<ReturnType<typeof createServer>> = []
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.shutdown()))
    await Promise.all(servers.splice(0).map(server => close(server)))
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
    resetServerHost()
    vi.restoreAllMocks()
  })

  it('uses the configured URI for authorization and token exchange while listening on its exact path', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const oauthServer = await listen((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        requests.push({ url: url.toString(), body })
        res.setHeader('content-type', 'application/json')
        if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
          res.end(JSON.stringify({ resource: 'https://mcp.example.test/mcp', authorization_servers: [`http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`] }))
        } else if (url.pathname === '/.well-known/oauth-authorization-server') {
          res.end(JSON.stringify({
            authorization_endpoint: `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}/authorize`,
            token_endpoint: `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}/token`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          }))
        } else if (url.pathname === '/token') {
          res.end(JSON.stringify({ access_token: 'access-token', token_type: 'Bearer' }))
        } else {
          res.statusCode = 404
          res.end('{}')
        }
      })
    })
    servers.push(oauthServer)

    const callbackReservation = await listen((_req, res) => res.end())
    const callbackPort = (callbackReservation.address() as AddressInfo).port
    await close(callbackReservation)
    const redirectUri = `http://127.0.0.1:${callbackPort}/oauth/callback`

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-mcp-oauth-'))
    tempDirs.push(dataDir)
    await fs.writeFile(path.join(dataDir, 'mcp-servers.json'), JSON.stringify({
      servers: {
        remote: {
          enabled: true,
          transport: 'http',
          url: 'https://mcp.example.test/mcp',
          oauth: {
            clientId: 'vega-client',
            tokenEndpointAuthMethod: 'none',
            redirectUri,
          },
        },
      },
    }))

    vi.spyOn(mcpOAuthSecretStore, 'load').mockResolvedValue({})
    vi.spyOn(mcpOAuthSecretStore, 'save').mockResolvedValue()

    let openedAuthorizationUrl = ''
    configureServerHost({
      bindHost: '127.0.0.1',
      preferredPort: 0,
      fallbackPorts: [],
      allowEphemeralPort: true,
      dataDir,
      tempDir: dataDir,
      dbPath: path.join(dataDir, 'test.db'),
      resourcesDir: dataDir,
      cors: { mode: 'loopback', allowedOrigins: [] },
      oauth: { enabled: false, callbackHost: '127.0.0.1', callbackPort: 1455 },
      toolRuntime: { mode: 'local', allowInProcessFallback: false },
      allowNonLoopbackBind: false,
    }, {
      configStore: { get: () => undefined, set: () => undefined, delete: () => undefined },
      secretStore: {
        getSecret: async () => null,
        setSecret: async () => undefined,
        deleteSecret: async () => undefined,
      },
      toolSandbox: null,
      openExternal: async url => {
        openedAuthorizationUrl = url
        const authorizationUrl = new URL(url)
        const response = await fetch(`${redirectUri}?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`)
        expect(response.status).toBe(200)
      },
    })

    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url)
      if (url.hostname === 'mcp.example.test') {
        if (url.pathname.startsWith('/.well-known/')) {
          const metadataUrl = new URL(url.pathname, `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`)
          return realFetch(metadataUrl, init)
        }
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer scope="openid"' },
        })
      }
      return realFetch(input, init)
    })

    const manager = new McpManager()
    managers.push(manager)
    await manager.initialize()
    const config = (await manager.getConfigs())[0]

    await expect(manager.startServer(config!)).rejects.toThrow('MCP HTTP request failed')

    const authorizationUrl = new URL(openedAuthorizationUrl)
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(redirectUri)
    const tokenRequest = requests.find(request => new URL(request.url).pathname === '/token')
    expect(new URLSearchParams(tokenRequest?.body).get('redirect_uri')).toBe(redirectUri)
  })
})
