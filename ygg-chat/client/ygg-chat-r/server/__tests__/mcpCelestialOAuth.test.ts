import { createHash } from 'crypto'
import fs from 'fs/promises'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpManager, type McpOAuthConfig } from '../mcp/mcpManager.js'
import { mcpOAuthSecretStore, type McpOAuthSecrets } from '../mcp/mcpOAuthSecrets.js'
import { configureServerHost, resetServerHost } from '../serverHost.js'

// Keep these independent of the implementation constants: the exception is pinned
// to this issuer, its hosted endpoints, and this registered public client.
const ISSUER = 'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_nSxSsgJuj'
const AUTHORIZE_ENDPOINT = 'https://vega-celestial-test.auth.us-east-2.amazoncognito.com/oauth2/authorize'
const TOKEN_ENDPOINT = 'https://vega-celestial-test.auth.us-east-2.amazoncognito.com/oauth2/token'
const CLIENT_ID = '5391d6flv8jtvpgg0b6j9f50dv'
const MCP_ENDPOINT = 'https://mcp.celestial.example.test/mcp'
const RESOURCE_METADATA = 'https://mcp.celestial.example.test/.well-known/oauth-protected-resource/mcp'
// Deliberately different from the endpoint, to catch accidentally dropping the resource binding.
const RESOURCE = 'https://mcp.celestial.example.test/canonical-resource'
const ISSUER_METADATA_CANDIDATES = [
  'https://cognito-idp.us-east-2.amazonaws.com/.well-known/oauth-authorization-server/us-east-2_nSxSsgJuj',
  'https://cognito-idp.us-east-2.amazonaws.com/.well-known/openid-configuration/us-east-2_nSxSsgJuj',
  `${ISSUER}/.well-known/openid-configuration`,
]
const ACCESS_TOKEN = 'CELESTIAL_ACCESS_TOKEN_ONLY'
const ID_TOKEN = 'CELESTIAL_ID_TOKEN_NOT_FOR_MCP'
const REFRESH_TOKEN = 'CELESTIAL_REFRESH_TOKEN'
const AUTHORIZATION_CODE = 'celestial-authorization-code'
const SCOPE = 'openid profile celestial/read'

const issuerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZE_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  // Match Cognito's discovery: the explicitly configured public client uses none.
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  // Cognito metadata intentionally has no code_challenge_methods_supported.
}

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

const callbackUrl = (authorizationUrl: URL) => {
  const url = new URL(authorizationUrl.searchParams.get('redirect_uri')!)
  url.searchParams.set('state', authorizationUrl.searchParams.get('state')!)
  url.searchParams.set('code', AUTHORIZATION_CODE)
  return url
}

const requestCallback = async (url: URL) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
  return { status: response.status, body: await response.text() }
}

type RpcRequest = { id?: number; method: string }

const rpcResult = (request: RpcRequest) => {
  switch (request.method) {
    case 'initialize':
      return { serverInfo: { name: 'celestial-test' } }
    case 'tools/list':
      return { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }] }
    case 'resources/list':
      return { resources: [] }
    case 'prompts/list':
      return { prompts: [] }
    case 'tools/call':
      return { content: [{ type: 'text', text: 'authenticated MCP result' }] }
    default:
      throw new Error(`Unexpected MCP method: ${request.method}`)
  }
}

describe('MCP Celestial TEST OAuth compatibility', () => {
  const managers: McpManager[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.shutdown()))
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
    resetServerHost()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const setup = async (options: {
    oauth?: Partial<McpOAuthConfig>
    savedSecrets?: McpOAuthSecrets
    redirectedDiscovery?: boolean
    mcpUrl?: string
    challengeScope?: string
    metadata?: Record<string, unknown>
    tokenHandler?: (init: RequestInit) => Promise<Response>
    otherConnection?: boolean
  } = {}) => {
    // Reserve then release an ephemeral port, as in mcpOAuthRedirectUri.test.ts,
    // so the manager itself binds the exact configured loopback URI.
    const reservation = createServer()
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const redirectUri = `http://127.0.0.1:${port}/oauth/celestial/callback`

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-mcp-celestial-'))
    tempDirs.push(dataDir)
    const configPath = path.join(dataDir, 'mcp-servers.json')
    await fs.writeFile(configPath, JSON.stringify({
      servers: {
        ...(options.otherConnection ? {
          other: { enabled: true, transport: 'http', url: 'https://other.example/mcp', oauth: { clientId: 'other-client' } },
        } : {}),
        remote: {
          enabled: true,
          autoStart: true,
          transport: 'http',
          url: options.mcpUrl || MCP_ENDPOINT,
          oauth: {
            allowMissingPkceS256ForCelestialTest: true,
            authorizationServer: ISSUER,
            clientId: CLIENT_ID,
            tokenEndpointAuthMethod: 'none',
            ...options.oauth,
            redirectUri,
          },
        },
      },
    }))

    // Model secure persistence without touching keytar or the host's credentials.
    let savedSecrets = { ...options.savedSecrets }
    let otherSecrets: McpOAuthSecrets = { accessToken: 'other-access', refreshToken: 'other-refresh' }
    const loadSecrets = vi.spyOn(mcpOAuthSecretStore, 'load').mockImplementation(async name => ({ ...(name === 'other' ? otherSecrets : savedSecrets) }))
    const clearSecrets = vi.spyOn(mcpOAuthSecretStore, 'clear').mockImplementation(async name => {
      if (name === 'other') otherSecrets = {}
      else savedSecrets = {}
    })
    const saveSecrets = vi.spyOn(mcpOAuthSecretStore, 'save').mockImplementation(async (name, secrets) => {
      if (name === 'other') {
        otherSecrets = { ...secrets }
        return
      }
      savedSecrets = Object.fromEntries(Object.entries(secrets).filter(([, value]) => Boolean(value)))
      if (Object.keys(savedSecrets).length === 0) await mcpOAuthSecretStore.clear(name)
    })

    vi.spyOn(mcpOAuthSecretStore, 'importLegacy').mockImplementation(async (name, secrets) => {
      if (name === 'other') { if (!Object.keys(otherSecrets).length) otherSecrets = { ...secrets } }
      else if (!Object.keys(savedSecrets).length) savedSecrets = { ...secrets }
    })
    vi.spyOn(mcpOAuthSecretStore, 'patch').mockImplementation(async (name, patch) => {
      const current = name === 'other' ? otherSecrets : savedSecrets
      const next = Object.fromEntries(Object.entries({ ...current, ...patch }).filter(([, value]) => Boolean(value)))
      await mcpOAuthSecretStore.save(name, next)
    })

    const events: string[] = []
    const callbacks: Array<{ status: number; body: string }> = []
    const openExternal = vi.fn(async (url: string) => {
      events.push('browser')
      callbacks.push(await requestCallback(callbackUrl(new URL(url))))
      events.push('callback')
    })
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
      openExternal,
    })

    const issuerRequests: Array<{ url: string; redirect?: RequestRedirect }> = []
    const tokenRequests: RequestInit[] = []
    const mcpRequests: Array<RpcRequest & { authorization: string | null }> = []
    const unexpectedRequests: string[] = []
    const realFetch = globalThis.fetch
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' || input instanceof URL ? new URL(input) : new URL(input.url)
      if (url.origin === new URL(redirectUri).origin) return realFetch(input, init)
      if (url.href === RESOURCE_METADATA) {
        events.push('resource-discovery')
        return jsonResponse({ resource: RESOURCE, authorization_servers: [ISSUER] })
      }
      if (ISSUER_METADATA_CANDIDATES.includes(url.href)) {
        issuerRequests.push({ url: url.href, redirect: init?.redirect })
        events.push('issuer-discovery')
        if (options.redirectedDiscovery) {
          // Emulate fetch's redirect:error behavior. Following the redirect would
          // return an otherwise convincing document claiming the pinned issuer.
          if (init?.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect')
          return jsonResponse(issuerMetadata)
        }
        return url.href === `${ISSUER}/.well-known/openid-configuration`
          ? jsonResponse({ ...issuerMetadata, ...options.metadata })
          : jsonResponse({}, 404)
      }
      if (url.href === TOKEN_ENDPOINT) {
        events.push('token-exchange')
        tokenRequests.push(init || {})
        if (options.tokenHandler) return options.tokenHandler(init || {})
        return jsonResponse({
          access_token: ACCESS_TOKEN,
          id_token: ID_TOKEN,
          refresh_token: REFRESH_TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
        })
      }
      if (url.href === (options.mcpUrl || MCP_ENDPOINT)) {
        const request = JSON.parse(String(init?.body)) as RpcRequest
        const authorization = new Headers(init?.headers).get('authorization')
        mcpRequests.push({ ...request, authorization })
        if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
          events.push('mcp:unauthorized')
          return new Response('', {
            status: 401,
            headers: { 'www-authenticate': `Bearer resource_metadata="${RESOURCE_METADATA}", scope="${options.challengeScope ?? SCOPE}"` },
          })
        }
        events.push('mcp:authorized')
        if (request.id === undefined) return new Response(null, { status: 202 })
        return jsonResponse({ jsonrpc: '2.0', id: request.id, result: rpcResult(request) })
      }
      unexpectedRequests.push(url.href)
      throw new Error(`Unexpected fetch: ${url.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const manager = new McpManager()
    managers.push(manager)
    await manager.initialize()
    return {
      manager, configPath, redirectUri, openExternal, fetchMock, callbacks, events,
      issuerRequests, tokenRequests, mcpRequests, unexpectedRequests,
      loadSecrets, saveSecrets, clearSecrets, getSavedSecrets: () => ({ ...savedSecrets }),
      getOtherSecrets: () => ({ ...otherSecrets }),
    }
  }

  it('discovers absent PKCE metadata after a 401, uses S256, and retries MCP with only the access token', async () => {
    const fixture = await setup()
    const { manager, openExternal, callbacks, events, redirectUri } = fixture
    expect(fixture.fetchMock).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(manager.getStatus()).toEqual([])

    openExternal.mockImplementation(async url => {
      events.push('browser')
      const callback = callbackUrl(new URL(url))
      const wrongPath = new URL(callback)
      wrongPath.pathname = '/not-the-configured-callback'
      callbacks.push(await requestCallback(wrongPath))
      callbacks.push(await requestCallback(callback))
      events.push('callback')
      // Keep openExternal pending so the listener is still open for a real replay.
      callbacks.push(await requestCallback(callback))
    })

    const result = await manager.callTool('mcp__remote__echo', { value: 'hello' })

    expect(result.content[0]?.text).toBe('authenticated MCP result')
    expect(manager.getServerStatus('remote')?.status).toBe('connected')
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(callbacks.map(callback => callback.status)).toEqual([404, 200, 400])
    expect(callbacks[2]?.body).toMatch(/already consumed/i)
    expect(fixture.unexpectedRequests).toEqual([])
    expect(fixture.issuerRequests).toEqual(ISSUER_METADATA_CANDIDATES.map(url => ({ url, redirect: 'error' })))
    expect(events.slice(0, 8)).toEqual([
      'mcp:unauthorized', 'resource-discovery',
      'issuer-discovery', 'issuer-discovery', 'issuer-discovery',
      'browser', 'callback', 'token-exchange',
    ])

    const authorizationUrl = new URL(openExternal.mock.calls[0]![0])
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(AUTHORIZE_ENDPOINT)
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      state: expect.any(String),
      code_challenge: expect.any(String),
      code_challenge_method: 'S256',
      resource: RESOURCE,
      scope: SCOPE,
    })
    expect(authorizationUrl.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32)
    expect(authorizationUrl.searchParams.has('code_verifier')).toBe(false)
    expect(authorizationUrl.searchParams.has('client_secret')).toBe(false)

    expect(fixture.tokenRequests).toHaveLength(1)
    const tokenRequest = fixture.tokenRequests[0]!
    expect(tokenRequest.method).toBe('POST')
    expect(tokenRequest.redirect).toBe('error')
    const tokenHeaders = new Headers(tokenRequest.headers)
    expect(tokenHeaders.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(tokenHeaders.has('authorization')).toBe(false)
    const tokenParams = new URLSearchParams(String(tokenRequest.body))
    expect(Object.fromEntries(tokenParams)).toEqual({
      grant_type: 'authorization_code',
      code: AUTHORIZATION_CODE,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      resource: RESOURCE,
      code_verifier: expect.any(String),
    })
    expect(tokenParams.has('client_secret')).toBe(false)
    const verifier = tokenParams.get('code_verifier')!
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
    expect(createHash('sha256').update(verifier).digest('base64url'))
      .toBe(authorizationUrl.searchParams.get('code_challenge'))

    expect(fixture.mcpRequests.slice(0, 2)).toEqual([
      expect.objectContaining({ method: 'initialize', authorization: null }),
      expect.objectContaining({ method: 'initialize', authorization: `Bearer ${ACCESS_TOKEN}` }),
    ])
    expect(fixture.mcpRequests.slice(1).every(request => request.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(true)
    expect(JSON.stringify(fixture.mcpRequests)).not.toContain(ID_TOKEN)
    expect(fixture.saveSecrets).toHaveBeenCalledWith('remote', expect.objectContaining({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    }))
    expect(fixture.getSavedSecrets()).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN })

    // The connected-status handler also persists asynchronously. Wait for that
    // write before reading/removing the fixture's configuration directory.
    await vi.waitFor(async () => {
      expect(fixture.getSavedSecrets().accessToken).toBe(ACCESS_TOKEN)
      const savedText = await fs.readFile(fixture.configPath, 'utf8')
      const saved = JSON.parse(savedText)
      expect(saved.servers.remote.oauth).toMatchObject({
        allowMissingPkceS256ForCelestialTest: true,
        authorizationServer: ISSUER,
        authorizationEndpoint: AUTHORIZE_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: CLIENT_ID,
        tokenEndpointAuthMethod: 'none',
        resource: RESOURCE,
        redirectUri,
      })
      for (const secret of [ACCESS_TOKEN, ID_TOKEN, REFRESH_TOKEN, AUTHORIZATION_CODE, verifier]) {
        expect(savedText).not.toContain(secret)
      }
      for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'id_token', 'code_verifier']) {
        expect(saved.servers.remote.oauth).not.toHaveProperty(key)
      }
    })
  })

  it.each([
    ['omitted (default off)', undefined],
    ['explicitly false', false],
  ] as const)('rejects absent S256 metadata with the flag %s without opening a browser', async (_label, flag) => {
    const fixture = await setup({ oauth: { allowMissingPkceS256ForCelestialTest: flag } })

    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/does not advertise PKCE S256/)

    expect(fixture.openExternal).not.toHaveBeenCalled()
    expect(fixture.tokenRequests).toEqual([])
    expect(fixture.mcpRequests).toHaveLength(1)
    expect(fixture.mcpRequests[0]?.authorization).toBeNull()
    expect(fixture.issuerRequests.map(request => request.url)).toEqual(ISSUER_METADATA_CANDIDATES)
    expect(fixture.saveSecrets).not.toHaveBeenCalled()
    expect(fixture.getSavedSecrets()).toEqual({})
    expect(fixture.unexpectedRequests).toEqual([])
  })

  it('rejects redirected issuer discovery even when the redirected document would match the pinned issuer', async () => {
    const fixture = await setup({ redirectedDiscovery: true })

    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/unexpected redirect/)

    expect(fixture.issuerRequests).toEqual(ISSUER_METADATA_CANDIDATES.map(url => ({ url, redirect: 'error' })))
    expect(fixture.openExternal).not.toHaveBeenCalled()
    expect(fixture.tokenRequests).toEqual([])
    expect(fixture.getSavedSecrets()).toEqual({})
    expect(fixture.unexpectedRequests).toEqual([])
  })

  it('clears saved credentials and discovered endpoints when updateServer disables the opt-in', async () => {
    const fixture = await setup({
      savedSecrets: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN },
      oauth: {
        authorizationEndpoint: AUTHORIZE_ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        registeredRedirectUri: 'http://127.0.0.1:6274/previous-callback',
        expiresAt: Date.now() + 3_600_000,
      },
    })
    expect(fixture.getSavedSecrets()).toEqual({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN })
    expect(fixture.loadSecrets).not.toHaveBeenCalled()

    await fixture.manager.updateServer('remote', { oauth: { allowMissingPkceS256ForCelestialTest: false } })

    expect(fixture.clearSecrets).toHaveBeenCalledWith('remote')
    expect(fixture.getSavedSecrets()).toEqual({})
    const saved = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'))
    expect(saved.servers.remote.oauth).toMatchObject({
      allowMissingPkceS256ForCelestialTest: false,
      authorizationServer: ISSUER,
      clientId: CLIENT_ID,
      tokenEndpointAuthMethod: 'none',
      redirectUri: fixture.redirectUri,
    })
    for (const key of ['accessToken', 'refreshToken', 'expiresAt', 'authorizationEndpoint', 'tokenEndpoint', 'registeredRedirectUri']) {
      expect(saved.servers.remote.oauth).not.toHaveProperty(key)
    }
    expect(fixture.fetchMock).not.toHaveBeenCalled()
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/does not advertise PKCE S256/)
    expect(fixture.mcpRequests.map(request => request.authorization)).toEqual([null])
    expect(fixture.openExternal).not.toHaveBeenCalled()
    expect(fixture.tokenRequests).toEqual([])
  })

  const localUrl = 'http://127.0.0.1:8081/api/mcp-gp/rpc'
  const localScopes = ['openid', 'profile', 'email', 'https://workbench.celestial.test.vega-alts.com/api/mcp-gp/rpc/invoke']
  const localOAuth = {
    omitResourceForLocalCelestialTest: true,
    scopes: localScopes,
    authorizationEndpoint: AUTHORIZE_ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    resource: localUrl,
  }

  it.each([undefined, false, true])('resource omission=%s controls authorization, code exchange, and refresh separately from PKCE', async flag => {
    const fixture = await setup({ mcpUrl: localUrl, challengeScope: localScopes[3], oauth: {
      ...localOAuth, omitResourceForLocalCelestialTest: flag,
    } })
    await fixture.manager.callTool('mcp__remote__echo', {})
    const authorization = new URL(fixture.openExternal.mock.calls[0]![0])
    const exchange = new URLSearchParams(String(fixture.tokenRequests[0]!.body))
    expect(authorization.searchParams.has('resource')).toBe(flag !== true)
    expect(exchange.has('resource')).toBe(flag !== true)
    if (flag !== true) expect(exchange.get('resource')).toBe(RESOURCE)
    else expect(authorization.searchParams.get('scope')).toBe(localScopes.join(' '))
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'))
      .toBe(authorization.searchParams.get('code_challenge'))
    await vi.waitFor(async () => {
      expect(fixture.getSavedSecrets().accessToken).toBe(ACCESS_TOKEN)
      const saved = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'))
      expect(saved.servers.remote.url).toBe(localUrl)
      expect(saved.servers.remote.oauth.resource).toBe(flag === true ? localUrl : RESOURCE)
    })
    await fixture.manager.stopServer('remote')
    await fixture.manager.updateServer('remote', { oauth: { expiresAt: 1 } })
    await fixture.manager.callTool('mcp__remote__echo', {})
    const refresh = new URLSearchParams(String(fixture.tokenRequests[1]!.body))
    expect(refresh.get('grant_type')).toBe('refresh_token')
    expect(refresh.has('resource')).toBe(flag !== true)
    expect(refresh.has('client_secret')).toBe(false)
    expect(fixture.openExternal).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fixture.tokenRequests.some(request => new URLSearchParams(String(request.body)).get('grant_type') === 'refresh_token')).toBe(true))
  })

  it.each([false, true])('does not substitute resource omission for PKCE approval (S256 advertised=%s)', async advertised => {
    const fixture = await setup({ mcpUrl: localUrl, challengeScope: localScopes.join(' '), oauth: {
      ...localOAuth, allowMissingPkceS256ForCelestialTest: false,
    }, metadata: advertised ? { code_challenge_methods_supported: ['S256'] } : {} })
    if (advertised) {
      await fixture.manager.callTool('mcp__remote__echo', {})
      expect(new URL(fixture.openExternal.mock.calls[0]![0]).searchParams.has('resource')).toBe(false)
      await vi.waitFor(() => expect(fixture.getSavedSecrets().accessToken).toBe(ACCESS_TOKEN))
    } else {
      await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/does not advertise PKCE/)
      expect(fixture.openExternal).not.toHaveBeenCalled()
    }
  })

  it.each([
    { issuer: 'https://other.test' },
    { authorization_endpoint: `${AUTHORIZE_ENDPOINT}?extra=1` },
    { token_endpoint: `${TOKEN_ENDPOINT}/other` },
  ])('rejects mismatched discovery even with valid S256: %j', async metadata => {
    const fixture = await setup({ mcpUrl: localUrl, challengeScope: localScopes.join(' '), oauth: localOAuth,
      metadata: { ...metadata, code_challenge_methods_supported: ['S256'] } })
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/Local Celestial/)
    expect(fixture.openExternal).not.toHaveBeenCalled()
    expect(fixture.tokenRequests).toEqual([])
  })

  it('rejects challenge scopes outside the approved set without a fallback', async () => {
    const fixture = await setup({ mcpUrl: localUrl, challengeScope: 'openid admin', oauth: localOAuth })
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/challenge scopes/)
    expect(fixture.openExternal).not.toHaveBeenCalled()
    expect(fixture.tokenRequests).toEqual([])
  })

  it('never enables resource omission automatically after token rejection', async () => {
    const fixture = await setup({ mcpUrl: localUrl, challengeScope: localScopes.join(' '),
      oauth: { ...localOAuth, omitResourceForLocalCelestialTest: false },
      tokenHandler: async () => jsonResponse({ error: 'invalid_scope' }, 400),
    })
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/Token exchange failed/)
    expect(fixture.tokenRequests).toHaveLength(1)
    expect(new URLSearchParams(String(fixture.tokenRequests[0]!.body)).has('resource')).toBe(true)
    const saved = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'))
    expect(saved.servers.remote.oauth.omitResourceForLocalCelestialTest).toBe(false)
    expect(fixture.getSavedSecrets()).toEqual({})
  })

  it('rejects invalid cached configuration before sending a bearer or refreshing', async () => {
    const fixture = await setup({ mcpUrl: localUrl, oauth: { ...localOAuth, clientId: 'wrong' },
      savedSecrets: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } })
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/Local Celestial/)
    expect(fixture.fetchMock).not.toHaveBeenCalled()
    expect(fixture.openExternal).not.toHaveBeenCalled()
  })

  it.each([false, true])('invalidates this connection only when resource omission changes from %s', async previous => {
    const fixture = await setup({ otherConnection: true, mcpUrl: localUrl, oauth: { ...localOAuth, omitResourceForLocalCelestialTest: previous },
      savedSecrets: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN } })
    await fixture.manager.updateServer('remote', { oauth: { omitResourceForLocalCelestialTest: !previous } })
    expect(fixture.getSavedSecrets()).toEqual({})
    expect(fixture.clearSecrets.mock.calls.every(([name]) => name === 'remote')).toBe(true)
    expect(fixture.getOtherSecrets()).toEqual({ accessToken: 'other-access', refreshToken: 'other-refresh', clientSecret: undefined })
    const saved = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'))
    expect(saved.servers.remote.oauth.omitResourceForLocalCelestialTest).toBe(!previous)
    expect(saved.servers.remote.oauth.allowMissingPkceS256ForCelestialTest).toBe(true)
    expect(saved.servers.remote.oauth.resource).toBe(localUrl)
    expect(saved.servers.remote.oauth).not.toHaveProperty('tokenEndpoint')
    expect(fixture.fetchMock).not.toHaveBeenCalled()
  })

  it('cancels pending login when resource omission changes', async () => {
    const fixture = await setup({ mcpUrl: localUrl, challengeScope: localScopes.join(' '), oauth: localOAuth })
    fixture.openExternal.mockImplementation(async () => undefined)
    const pending = fixture.manager.callTool('mcp__remote__echo', {}).catch(error => error)
    await vi.waitFor(() => expect(fixture.openExternal).toHaveBeenCalledTimes(1))
    await fixture.manager.updateServer('remote', { oauth: { omitResourceForLocalCelestialTest: false } })
    expect(await pending).toBeInstanceOf(Error)
    expect(fixture.tokenRequests).toEqual([])
    expect(fixture.getSavedSecrets()).toEqual({})
    const saved = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'))
    expect(saved.servers.remote.oauth.omitResourceForLocalCelestialTest).toBe(false)
  })

  it.each([false, true])('cancels in-flight refresh without fallback or stale tokens (late success=%s)', async lateSuccess => {
    let release!: () => void
    const fixture = await setup({ mcpUrl: localUrl, oauth: { ...localOAuth, expiresAt: 1 },
      savedSecrets: { refreshToken: REFRESH_TOKEN },
      tokenHandler: init => new Promise((resolve, reject) => {
        release = () => resolve(jsonResponse({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }))
        if (!lateSuccess) init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })
    const pending = fixture.manager.callTool('mcp__remote__echo', {}).catch(error => error)
    await vi.waitFor(() => expect(fixture.tokenRequests).toHaveLength(1))
    const update = fixture.manager.updateServer('remote', { oauth: { omitResourceForLocalCelestialTest: false } })
    await vi.waitFor(() => expect(fixture.tokenRequests[0]!.signal?.aborted).toBe(true))
    release()
    await update
    expect(await pending).toBeInstanceOf(Error)
    expect(fixture.openExternal).not.toHaveBeenCalled()
    expect(fixture.getSavedSecrets()).toEqual({})
    expect(fixture.mcpRequests).toEqual([])
  })

  it('cancels a pending login before saving changed compatibility approval', async () => {
    const fixture = await setup()
    fixture.openExternal.mockImplementation(async () => undefined)
    const pending = fixture.manager.callTool('mcp__remote__echo', {}).catch(error => error as Error)
    await vi.waitFor(() => expect(fixture.openExternal).toHaveBeenCalledTimes(1))

    await fixture.manager.updateServer('remote', { oauth: { allowMissingPkceS256ForCelestialTest: false } })
    expect(await pending).toBeInstanceOf(Error)
    expect(fixture.tokenRequests).toEqual([])
    expect(fixture.getSavedSecrets()).toEqual({})
    const saved = JSON.parse(await fs.readFile(fixture.configPath, 'utf8'))
    expect(saved.servers.remote.oauth.allowMissingPkceS256ForCelestialTest).toBe(false)
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/does not advertise PKCE S256/)
    expect(fixture.openExternal).toHaveBeenCalledTimes(1)
  })

  it('generates fresh state and S256 challenges after a denied attempt', async () => {
    const fixture = await setup()
    fixture.openExternal.mockImplementation(async url => {
      const callback = callbackUrl(new URL(url))
      callback.searchParams.set('error', 'access_denied')
      await requestCallback(callback)
    })
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/denied/)
    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(/denied/)
    const first = new URL(fixture.openExternal.mock.calls[0]![0])
    const second = new URL(fixture.openExternal.mock.calls[1]![0])
    expect(second.searchParams.get('state')).not.toBe(first.searchParams.get('state'))
    expect(second.searchParams.get('code_challenge')).not.toBe(first.searchParams.get('code_challenge'))
    expect(second.searchParams.get('code_challenge_method')).toBe('S256')
    expect(fixture.tokenRequests).toEqual([])
  })

  it.each([
    ['wrong state', (url: URL) => url.searchParams.set('state', 'wrong-state'), /Invalid OAuth state/],
    ['missing state', (url: URL) => url.searchParams.delete('state'), /Invalid OAuth state/],
    ['user denial', (url: URL) => url.searchParams.set('error', 'access_denied'), /authorization failed or was denied/],
    ['missing code', (url: URL) => url.searchParams.delete('code'), /missing authorization code/],
  ] as const)('rejects %s and consumes the callback without exchanging a code', async (_label, mutate, error) => {
    const fixture = await setup()
    fixture.openExternal.mockImplementation(async url => {
      const validCallback = callbackUrl(new URL(url))
      const invalidCallback = new URL(validCallback)
      mutate(invalidCallback)
      fixture.callbacks.push(await requestCallback(invalidCallback))
      fixture.callbacks.push(await requestCallback(validCallback))
    })

    await expect(fixture.manager.callTool('mcp__remote__echo', {})).rejects.toThrow(error)

    expect(fixture.openExternal).toHaveBeenCalledTimes(1)
    expect(fixture.callbacks.map(callback => callback.status)).toEqual([400, 400])
    expect(fixture.callbacks[1]?.body).toMatch(/already consumed/i)
    expect(fixture.tokenRequests).toEqual([])
    expect(fixture.mcpRequests).toHaveLength(1)
    expect(fixture.getSavedSecrets()).toEqual({})
    expect(fixture.unexpectedRequests).toEqual([])
  })
})
