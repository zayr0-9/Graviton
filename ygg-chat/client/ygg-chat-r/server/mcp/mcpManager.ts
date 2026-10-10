// server/mcp/mcpManager.ts
// MCP (Model Context Protocol) server manager
// Manages connections to MCP servers that provide tools, resources, and prompts

import { spawn, ChildProcess } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { EventEmitter } from 'events'
import { createServer, type Server as HttpServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import {
  buildAuthorizationServerMetadataCandidates,
  buildProtectedResourceMetadataCandidates,
  parseWwwAuthenticateBearerChallenge,
  validateOAuthPkceMetadata,
  shouldOmitLocalCelestialResource,
  CELESTIAL_TEST_ISSUER,
  CELESTIAL_TEST_CLIENT_ID,
} from './oauthDiscovery.js'
import { mcpOAuthSecretStore, type McpOAuthSecrets } from './mcpOAuthSecrets.js'
import { tryGetHostCapabilities, tryGetServerConfig } from '../serverHost.js'
import { withCredentialVaultLock } from '../credentialVaultLock.js'

// ============================================================================
// Types and Interfaces
// ============================================================================

export type McpServerTransport = 'stdio' | 'http'
export type McpStdioFraming = 'content-length' | 'newline-json'

export interface McpOAuthConfig {
  // Trusted per-connection opt-in; never populated from remote metadata.
  allowMissingPkceS256ForCelestialTest?: boolean
  omitResourceForLocalCelestialTest?: boolean
  resourceMetadataUrl?: string
  resource?: string
  authorizationServer?: string
  authorizationEndpoint?: string
  tokenEndpoint?: string
  registrationEndpoint?: string
  scopes?: string[]
  clientId?: string
  clientSecret?: string
  tokenEndpointAuthMethod?: 'client_secret_post' | 'none'
  clientMode?: 'configured' | 'dynamic'
  redirectUri?: string
  registeredRedirectUri?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

export interface McpServerConfig {
  name: string
  enabled: boolean
  autoStart?: boolean // Start when app launches (default: true)

  // Transport selection
  transport?: McpServerTransport
  type?: McpServerTransport // Backward compatibility with .mcp.json-style configs

  // stdio transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  stdioFraming?: McpStdioFraming

  // remote HTTP transport
  url?: string
  headers?: Record<string, string>

  // OAuth state for remote transport
  oauth?: McpOAuthConfig
  credentialStorage?: 'vault' | 'anonymous'
}

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, any>
    required?: string[]
  }
  _meta?: {
    ui?: {
      resourceUri?: string
      visibility?: Array<'model' | 'app'>
    }
    'ui/resourceUri'?: string
  }
  // Added by manager
  serverName?: string
  qualifiedName?: string // mcp__serverName__toolName
}

export interface McpResourceDefinition {
  uri: string
  name?: string
  description?: string
  mimeType?: string
  serverName?: string
}

export interface McpPromptDefinition {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
  serverName?: string
}

export interface McpToolCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
    resource?: { uri: string; mimeType?: string; text?: string }
  }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface McpServerStatus {
  name: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  tools: McpToolDefinition[]
  resources: McpResourceDefinition[]
  prompts: McpPromptDefinition[]
  pid?: number
}

export interface McpToolsChangedEvent {
  serverName: string
  tools: McpToolDefinition[]
}

// JSON-RPC message types
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: any
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: any
  error?: { code: number; message: string; data?: any }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: any
}

interface OAuthProtectedResourceMetadata {
  resource?: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

interface OAuthAuthorizationServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  client_id_metadata_document_supported?: boolean
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
}

function normalizeTransport(value: unknown): McpServerTransport | undefined {
  if (value === 'http') return 'http'
  if (value === 'stdio') return 'stdio'
  return undefined
}

function resolveTransport(config: Partial<McpServerConfig>): McpServerTransport {
  return normalizeTransport(config.transport) ?? normalizeTransport(config.type) ?? (config.url ? 'http' : 'stdio')
}

function resolveStdioFraming(config: Partial<McpServerConfig>): McpStdioFraming {
  if (config.stdioFraming === 'content-length' || config.stdioFraming === 'newline-json') {
    return config.stdioFraming
  }

  const command = typeof config.command === 'string' ? path.basename(config.command).toLowerCase() : ''
  if (command === 'blender-mcp' || command === 'blender-mcp.exe') {
    return 'newline-json'
  }

  return 'content-length'
}

const MCP_PROTOCOL_VERSION = '2025-11-25'
const OAUTH_ACCESS_TOKEN_CLOCK_SKEW_MS = 60_000
const DEFAULT_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback'

export type McpOAuthCallbackBinding = {
  redirectUri: string
  hostname: '127.0.0.1' | 'localhost'
  port: number
  pathname: string
}

export function parseMcpOAuthRedirectUri(value: string): McpOAuthCallbackBinding {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('"oauth.redirectUri" must be a valid absolute URL')
  }

  if (parsed.protocol !== 'http:') {
    throw new Error('"oauth.redirectUri" must use http for a local OAuth callback')
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('"oauth.redirectUri" must use the loopback host 127.0.0.1 or localhost')
  }
  if (!parsed.port) {
    throw new Error('"oauth.redirectUri" must include an explicit port')
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('"oauth.redirectUri" port must be between 1 and 65535')
  }
  if (parsed.username || parsed.password) {
    throw new Error('"oauth.redirectUri" must not include credentials')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('"oauth.redirectUri" must not include a query string or fragment')
  }

  return {
    redirectUri: parsed.toString(),
    hostname: parsed.hostname,
    port,
    pathname: parsed.pathname || '/',
  }
}

const OAUTH_SECRET_KEYS: Array<keyof McpOAuthSecrets> = ['accessToken', 'refreshToken', 'clientSecret']

function extractOAuthSecrets(oauth: McpOAuthConfig | undefined): McpOAuthSecrets {
  if (!oauth) return {}
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    clientSecret: oauth.clientSecret,
  }
}

function stripOAuthSecrets(oauth: McpOAuthConfig | undefined): McpOAuthConfig | undefined {
  if (!oauth) return undefined
  const sanitized = { ...oauth }
  for (const key of OAUTH_SECRET_KEYS) delete sanitized[key]
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function hasOAuthSecrets(oauth: McpOAuthConfig | undefined): boolean {
  return OAUTH_SECRET_KEYS.some(key => Boolean(oauth?.[key]))
}

// ============================================================================
// MCP Client - Handles communication with a single MCP server
// ============================================================================

class McpClient extends EventEmitter {
  private process: ChildProcess | null = null
  private requestId = 0
  private pendingRequests: Map<number | string, {
    resolve: (value: any) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }> = new Map()
  private buffer = Buffer.alloc(0)
  private sessionId?: string
  private readonly transport: McpServerTransport
  private readonly stdioFraming: McpStdioFraming
  private oauth?: McpOAuthConfig
  private authFlowPromise: Promise<void> | null = null
  private oauthAbortController?: AbortController
  private lastOAuthError?: string

  public status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  public error?: string
  public tools: McpToolDefinition[] = []
  public resources: McpResourceDefinition[] = []
  public prompts: McpPromptDefinition[] = []

  constructor(
    public readonly name: string,
    public readonly config: McpServerConfig,
    private readonly onOAuthChanged?: (oauth: McpOAuthConfig) => Promise<void>,
    private readonly onToolsChanged?: (tools: McpToolDefinition[]) => void
  ) {
    super()
    this.transport = resolveTransport(config)
    this.stdioFraming = resolveStdioFraming(config)
    this.oauth = config.oauth ? { ...config.oauth } : undefined
  }

  async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return
    }

    this.status = 'connecting'
    this.error = undefined
    this.emit('statusChange', this.status)

    try {
      if (this.transport === 'http') {
        await this.connectHttp()
      } else {
        await this.connectStdio()
      }

      // Initialize the connection
      await this.initialize()

      // Fetch capabilities
      await this.refreshCapabilities()

      this.status = 'connected'
      this.emit('statusChange', this.status)
      console.log(`[MCP:${this.name}] Connected successfully (${this.transport})`)
    } catch (err) {
      this.status = 'error'
      this.error = err instanceof Error ? err.message : String(err)
      this.emit('statusChange', this.status)
      await this.disconnect({ preserveStatus: true })
      throw err
    }
  }

  private async connectStdio(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`MCP stdio server '${this.name}' is missing command`)
    }

    const env = { ...process.env, ...this.config.env }
    const args = Array.isArray(this.config.args) ? this.config.args : []

    this.process = spawn(this.config.command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })

    // Handle stdout (Content-Length framed JSON-RPC messages)
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data)
    })

    // Handle stderr (logging)
    this.process.stderr?.on('data', (data: Buffer) => {
      console.log(`[MCP:${this.name}] stderr:`, data.toString().trim())
    })

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`[MCP:${this.name}] Process exited with code ${code}, signal ${signal}`)
      this.status = 'disconnected'
      this.process = null
      this.emit('statusChange', this.status)
      this.rejectAllPending(new Error('MCP server process exited'))
    })

    this.process.on('error', (err) => {
      console.error(`[MCP:${this.name}] Process error:`, err)
      this.status = 'error'
      this.error = err.message
      this.emit('statusChange', this.status)
    })
  }

  private async connectHttp(): Promise<void> {
    if (!this.config.url) {
      throw new Error(`MCP HTTP server '${this.name}' is missing url`)
    }

    shouldOmitLocalCelestialResource(this.config.url, this.oauth, Boolean(this.oauth?.accessToken || this.oauth?.refreshToken))
    this.sessionId = undefined
  }

  async disconnect(options: { preserveStatus?: boolean } = {}): Promise<void> {
    this.oauthAbortController?.abort()
    if (this.process) {
      this.process.kill('SIGTERM')

      // Force kill after timeout
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL')
        }
      }, 5000)
    }

    this.process = null
    this.sessionId = undefined
    if (!options.preserveStatus) {
      this.status = 'disconnected'
      this.error = undefined
    }
    this.tools = []
    this.resources = []
    this.prompts = []
    this.rejectAllPending(new Error('Disconnected'))
    this.emit('statusChange', this.status)
  }

  async waitForOAuthCompletion(): Promise<void> {
    await this.authFlowPromise?.catch(() => undefined)
  }

  async callTool(toolName: string, args: any): Promise<McpToolCallResult> {
    const response = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    })
    return response as McpToolCallResult
  }

  async readResource(uri: string): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }> {
    const response = await this.sendRequest('resources/read', { uri })
    return response
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<{ description?: string; messages: Array<{ role: string; content: any }> }> {
    const response = await this.sendRequest('prompts/get', { name, arguments: args })
    return response
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
        },
      },
      clientInfo: {
        name: 'ygg-chat',
        version: '1.0.0',
      },
    })

    console.log(`[MCP:${this.name}] Initialized with server:`, result.serverInfo?.name)

    // Send initialized notification
    this.sendNotification('notifications/initialized', {})
  }

  private async refreshCapabilities(): Promise<void> {
    // Fetch tools
    try {
      const toolsResult = await this.sendRequest('tools/list', {})
      this.tools = (toolsResult.tools || []).map((tool: McpToolDefinition) => ({
        ...tool,
        serverName: this.name,
        qualifiedName: `mcp__${this.name}__${tool.name}`,
      }))
      this.onToolsChanged?.(this.tools)
      console.log(`[MCP:${this.name}] Loaded ${this.tools.length} tools`)
    } catch (err) {
      console.log(`[MCP:${this.name}] No tools available:`, err)
      this.tools = []
    }

    // Fetch resources
    try {
      const resourcesResult = await this.sendRequest('resources/list', {})
      this.resources = (resourcesResult.resources || []).map((r: McpResourceDefinition) => ({
        ...r,
        serverName: this.name,
      }))
      console.log(`[MCP:${this.name}] Loaded ${this.resources.length} resources`)
    } catch (err) {
      console.log(`[MCP:${this.name}] No resources available`)
      this.resources = []
    }

    // Fetch prompts
    try {
      const promptsResult = await this.sendRequest('prompts/list', {})
      this.prompts = (promptsResult.prompts || []).map((p: McpPromptDefinition) => ({
        ...p,
        serverName: this.name,
      }))
      console.log(`[MCP:${this.name}] Loaded ${this.prompts.length} prompts`)
    } catch (err) {
      console.log(`[MCP:${this.name}] No prompts available`)
      this.prompts = []
    }
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])

    if (this.stdioFraming === 'newline-json') {
      this.handleNewlineJsonData()
      return
    }

    this.handleContentLengthData()
  }

  private handleContentLengthData(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8')
      const contentLengthMatch = headerText.match(/(?:^|\r\n)content-length:\s*(\d+)/i)

      if (!contentLengthMatch) {
        console.error(`[MCP:${this.name}] Missing Content-Length header in stdio response:`, headerText)
        this.buffer = Buffer.alloc(0)
        return
      }

      const contentLength = Number.parseInt(contentLengthMatch[1], 10)
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        console.error(`[MCP:${this.name}] Invalid Content-Length header in stdio response:`, contentLengthMatch[1])
        this.buffer = Buffer.alloc(0)
        return
      }

      const messageStart = headerEnd + 4
      const messageEnd = messageStart + contentLength
      if (this.buffer.length < messageEnd) {
        return
      }

      const messageText = this.buffer.subarray(messageStart, messageEnd).toString('utf8')
      this.buffer = this.buffer.subarray(messageEnd)
      this.parseStdioJson(messageText)
    }
  }

  private handleNewlineJsonData(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf(0x0a)
      if (newlineIndex === -1) {
        return
      }

      const line = this.buffer.subarray(0, newlineIndex).toString('utf8').trim()
      this.buffer = this.buffer.subarray(newlineIndex + 1)

      if (!line) {
        continue
      }

      this.parseStdioJson(line)
    }
  }

  private parseStdioJson(messageText: string): void {
    try {
      const message = JSON.parse(messageText)
      this.handleMessage(message)
    } catch (err) {
      console.error(`[MCP:${this.name}] Failed to parse stdio message:`, messageText, err)
    }
  }

  private encodeStdioMessage(message: JsonRpcRequest | JsonRpcNotification): Buffer {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    if (this.stdioFraming === 'newline-json') {
      return Buffer.concat([body, Buffer.from('\n', 'utf8')])
    }
    const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'utf8')
    return Buffer.concat([header, body])
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    // Check if it's a response (has id)
    if ('id' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(message.id)

        if ('error' in message && message.error) {
          pending.reject(new Error(message.error.message))
        } else {
          pending.resolve(message.result)
        }
      }
    } else if ('method' in message) {
      // It's a notification
      this.handleNotification(message as JsonRpcNotification)
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    console.log(`[MCP:${this.name}] Notification:`, notification.method)

    switch (notification.method) {
      case 'notifications/tools/list_changed':
        this.refreshCapabilities()
        break
      case 'notifications/resources/list_changed':
        this.refreshCapabilities()
        break
      case 'notifications/prompts/list_changed':
        this.refreshCapabilities()
        break
    }
  }

  private sendRequest(method: string, params?: any): Promise<any> {
    if (this.transport === 'http') {
      return this.sendHttpRequest(method, params)
    }

    return this.sendStdioRequest(method, params)
  }

  private sendStdioRequest(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('MCP server not connected'))
        return
      }

      const id = ++this.requestId
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timed out: ${method}`))
      }, 30000)

      this.pendingRequests.set(id, { resolve, reject, timeout })

      const message = this.encodeStdioMessage(request)
      this.process.stdin.write(message)
    })
  }

  private async sendHttpRequest(method: string, params?: any, allowAuthRetry = true): Promise<any> {
    if (!this.config.url) {
      throw new Error(`MCP HTTP server '${this.name}' is missing url`)
    }

    const id = ++this.requestId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      this.lastOAuthError = undefined
      await this.prepareHttpAuthentication()
      const headers = this.buildHttpHeaders()

      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      const responseSessionId = response.headers.get('mcp-session-id')
      if (responseSessionId) {
        this.sessionId = responseSessionId
      }

      const payload = await response.text()

      if (response.status === 401 && allowAuthRetry) {
        const authenticated = await this.tryHandleHttpUnauthorized(response)
        if (authenticated) {
          return this.sendHttpRequest(method, params, false)
        }
      }

      if (!response.ok) {
        const wwwAuthenticate = response.headers.get('www-authenticate')
        const oauthHint =
          response.status === 401 && wwwAuthenticate
            ? ` | OAuth required. WWW-Authenticate: ${wwwAuthenticate}`
            : ''
        const oauthFailureHint =
          response.status === 401 && this.lastOAuthError ? ` | OAuth flow failed: ${this.lastOAuthError}` : ''

        throw new Error(
          `MCP HTTP request failed (${response.status} ${response.statusText})${payload ? `: ${payload.slice(0, 400)}` : ''}${oauthHint}${oauthFailureHint}`
        )
      }

      if (!payload.trim()) {
        return undefined
      }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('text/event-stream')) {
        return this.resolveJsonRpcFromSse(payload, id)
      }

      try {
        const parsed = JSON.parse(payload)
        return this.resolveJsonRpcPayload(parsed, id)
      } catch (parseError) {
        if (payload.includes('\ndata:')) {
          return this.resolveJsonRpcFromSse(payload, id)
        }
        throw new Error(
          `MCP HTTP response parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`
        )
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private buildHttpHeaders(): Record<string, string> {

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...(this.config.headers || {}),
    }

    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId
    }

    if (this.oauth?.accessToken) {
      headers.Authorization = `Bearer ${this.oauth.accessToken}`
    }

    return headers
  }

  private async prepareHttpAuthentication(): Promise<void> {
    if (!this.oauth?.accessToken && !this.oauth?.refreshToken) return
    await this.ensureOAuthAccessToken()
  }

  private async tryHandleHttpUnauthorized(response: Response): Promise<boolean> {
    if (this.transport !== 'http') return false

    // If caller explicitly configured a static Authorization header and we don't have OAuth state,
    // do not override with interactive auth.
    if (this.config.headers?.Authorization && !this.oauth?.refreshToken && !this.oauth?.accessToken) {
      this.lastOAuthError =
        'Static Authorization header is configured; skipping interactive OAuth because no OAuth token state is present.'
      return false
    }

    const wwwAuthenticate = response.headers.get('www-authenticate')
    const challenge = parseWwwAuthenticateBearerChallenge(wwwAuthenticate)

    // A rejected access token must not be considered reusable by ensureOAuthAccessToken.
    // Preserve the refresh token so the single retry can refresh before reopening the browser.
    if (this.oauth?.accessToken) {
      this.oauth = { ...this.oauth, accessToken: undefined, expiresAt: undefined }
    }

    try {
      await this.ensureOAuthAccessToken({
        resourceMetadataUrlHint: challenge.resourceMetadataUrl,
        challengeScope: challenge.scope,
      })
      const authenticated = Boolean(this.oauth?.accessToken)
      this.lastOAuthError = authenticated ? undefined : 'OAuth flow completed without obtaining an access token.'
      return authenticated
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastOAuthError = message
      console.error(`[MCP:${this.name}] OAuth flow failed:`, error)
      return false
    }
  }

  private async ensureOAuthAccessToken(input?: {
    resourceMetadataUrlHint?: string
    challengeScope?: string
  }): Promise<void> {
    if (!this.config.url) {
      throw new Error(`MCP HTTP server '${this.name}' is missing url`)
    }

    if (this.authFlowPromise) {
      return this.authFlowPromise
    }

    const controller = new AbortController()
    this.oauthAbortController = controller
    this.authFlowPromise = (async () => {
      this.oauth = this.oauth || this.config.oauth || {}
      shouldOmitLocalCelestialResource(this.config.url, this.oauth, Boolean(this.oauth.accessToken || this.oauth.refreshToken))

      const now = Date.now()
      if (this.oauth.accessToken && (!this.oauth.expiresAt || this.oauth.expiresAt > now + OAUTH_ACCESS_TOKEN_CLOCK_SKEW_MS)) {
        return
      }

      if (this.canRefreshOAuthToken()) {
        try {
          await this.refreshOAuthToken()
          return
        } catch (error) {
          controller.signal.throwIfAborted()
          console.warn(`[MCP:${this.name}] Refresh token failed, falling back to browser auth:`, error)
        }
      }

      controller.signal.throwIfAborted()
      await this.runInteractiveOAuthFlow(input, controller.signal)
    })()

    try {
      await this.authFlowPromise
    } finally {
      this.authFlowPromise = null
      if (this.oauthAbortController === controller) this.oauthAbortController = undefined
    }
  }

  private canRefreshOAuthToken(): boolean {
    if (!this.oauth?.refreshToken || !this.oauth?.tokenEndpoint || !this.oauth?.clientId) {
      return false
    }

    const authMethod = this.oauth.tokenEndpointAuthMethod || (this.oauth.clientSecret ? 'client_secret_post' : 'none')
    if (authMethod === 'none') {
      return true
    }

    return Boolean(this.oauth.clientSecret)
  }

  private async runInteractiveOAuthFlow(input: {
    resourceMetadataUrlHint?: string
    challengeScope?: string
  } | undefined, signal: AbortSignal): Promise<void> {
    if (!this.config.url) {
      throw new Error(`MCP HTTP server '${this.name}' is missing url`)
    }

    const state = randomBytes(24).toString('hex')
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

    const callbackServer = await this.createOAuthCallbackServer(state, this.oauth?.redirectUri, signal)

    try {
      const oauthMeta = await this.discoverOAuthMetadata(input)
      signal.throwIfAborted()
      const client = await this.resolveOAuthClientCredentials(oauthMeta, callbackServer.redirectUri)
      signal.throwIfAborted()
      this.oauth = {
        ...this.oauth,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
        clientMode: client.clientMode,
        registeredRedirectUri: client.registeredRedirectUri,
      }
      await this.persistOAuthState()

      const authUrl = new URL(oauthMeta.authorizationEndpoint)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', client.clientId)
      authUrl.searchParams.set('redirect_uri', callbackServer.redirectUri)
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      if (!oauthMeta.omitResource) authUrl.searchParams.set('resource', oauthMeta.resource)
      if (oauthMeta.scope) {
        authUrl.searchParams.set('scope', oauthMeta.scope)
      }

      const openExternal = tryGetHostCapabilities()?.openExternal
      if (!openExternal) {
        throw new Error(
          'MCP OAuth requires a browser. This host cannot open authorization URLs.'
        )
      }
      signal.throwIfAborted()
      try {
        await openExternal(authUrl.toString())
      } catch {
        throw new Error('Unable to open OAuth authorization in the browser')
      }

      const authCode = await callbackServer.waitForCode(5 * 60_000)

      const token = await this.exchangeAuthorizationCodeForToken({
        code: authCode,
        codeVerifier,
        redirectUri: callbackServer.redirectUri,
        tokenEndpoint: oauthMeta.tokenEndpoint,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
        resource: oauthMeta.resource,
        omitResource: oauthMeta.omitResource,
        signal,
      })
      signal.throwIfAborted()

      this.oauth = {
        ...this.oauth,
        resourceMetadataUrl: oauthMeta.resourceMetadataUrl,
        resource: oauthMeta.resource,
        authorizationServer: oauthMeta.authorizationServer,
        authorizationEndpoint: oauthMeta.authorizationEndpoint,
        tokenEndpoint: oauthMeta.tokenEndpoint,
        registrationEndpoint: oauthMeta.registrationEndpoint,
        scopes: oauthMeta.scope ? oauthMeta.scope.split(' ').filter(Boolean) : this.oauth?.scopes,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
        clientMode: client.clientMode,
        registeredRedirectUri: client.registeredRedirectUri,
        accessToken: token.access_token,
        refreshToken: token.refresh_token || this.oauth?.refreshToken,
        expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
      }

      await this.persistOAuthState()
      this.lastOAuthError = undefined
    } finally {
      await callbackServer.close().catch(() => undefined)
    }
  }

  private async discoverOAuthMetadata(input?: {
    resourceMetadataUrlHint?: string
    challengeScope?: string
  }): Promise<{
    resourceMetadataUrl: string
    omitResource: boolean
    resource: string
    authorizationServer: string
    authorizationEndpoint: string
    tokenEndpoint: string
    registrationEndpoint?: string
    scope?: string
    tokenEndpointAuthMethod: 'client_secret_post' | 'none'
  }> {
    if (!this.config.url) {
      throw new Error(`MCP HTTP server '${this.name}' is missing url`)
    }

    const mcpUrl = new URL(this.config.url)
    const resourceMetadataCandidates = [
      input?.resourceMetadataUrlHint,
      this.oauth?.resourceMetadataUrl,
      ...buildProtectedResourceMetadataCandidates(mcpUrl),
    ].filter((value): value is string => Boolean(value))

    const protectedResourceResult = await this.fetchFirstJson<OAuthProtectedResourceMetadata>(resourceMetadataCandidates)
    const protectedResource = protectedResourceResult.value

    const authorizationServer = this.oauth?.authorizationServer || protectedResource.authorization_servers?.[0]
    if (!authorizationServer) {
      throw new Error('OAuth discovery failed: authorization server not provided by protected resource metadata')
    }

    const authServerMetadataCandidates = buildAuthorizationServerMetadataCandidates(authorizationServer)
    // Only documents fetched directly from the pinned HTTPS issuer may use the exception.
    // Do not follow redirects to an arbitrary document that claims the same issuer.
    const pinnedDiscovery = (this.oauth?.allowMissingPkceS256ForCelestialTest === true ||
      this.oauth?.omitResourceForLocalCelestialTest === true) && authorizationServer === CELESTIAL_TEST_ISSUER
    const authServerMetadataResult = await this.fetchFirstJson<OAuthAuthorizationServerMetadata>(authServerMetadataCandidates, pinnedDiscovery)
    const authServerMetadata = authServerMetadataResult.value

    if (!authServerMetadata.authorization_endpoint || !authServerMetadata.token_endpoint) {
      throw new Error('OAuth discovery failed: authorization/token endpoints missing in auth server metadata')
    }

    const usedPkceException = validateOAuthPkceMetadata(
      authServerMetadata,
      authorizationServer,
      this.oauth?.allowMissingPkceS256ForCelestialTest === true
    )
    if (usedPkceException) {
      if (
        this.oauth?.clientId !== CELESTIAL_TEST_CLIENT_ID ||
        this.oauth.tokenEndpointAuthMethod !== 'none' ||
        this.oauth.clientSecret ||
        this.oauth.clientMode === 'dynamic'
      ) {
        throw new Error('Celestial TEST compatibility requires the registered public client ID, token authentication "none", and no client secret')
      }
      console.info('oauth_pkce_metadata_exception_used', { issuer: CELESTIAL_TEST_ISSUER, connectionId: this.name })
    }

    const omitResource = shouldOmitLocalCelestialResource(this.config.url, {
      ...this.oauth,
      authorizationServer,
      authorizationEndpoint: authServerMetadata.authorization_endpoint,
      tokenEndpoint: authServerMetadata.token_endpoint,
    })
    if (omitResource && (authServerMetadata.issuer !== authorizationServer ||
      input?.challengeScope?.split(/\s+/).filter(Boolean).some(scope => !this.oauth?.scopes?.includes(scope)))) {
      throw new Error('Local Celestial resource omission rejected mismatched discovery issuer or challenge scopes')
    }
    const scope =
      (omitResource ? this.oauth?.scopes?.join(' ') : input?.challengeScope) ||
      this.oauth?.scopes?.join(' ') ||
      (Array.isArray(protectedResource.scopes_supported) && protectedResource.scopes_supported.length > 0
        ? protectedResource.scopes_supported.join(' ')
        : undefined)

    const tokenEndpointAuthMethod = this.selectTokenEndpointAuthMethod(
      this.oauth?.tokenEndpointAuthMethod,
      authServerMetadata.token_endpoint_auth_methods_supported
    )

    return {
      resourceMetadataUrl: protectedResourceResult.url,
      omitResource,
      resource: omitResource ? this.config.url : protectedResource.resource || this.config.url,
      authorizationServer,
      authorizationEndpoint: authServerMetadata.authorization_endpoint,
      tokenEndpoint: authServerMetadata.token_endpoint,
      registrationEndpoint: authServerMetadata.registration_endpoint,
      scope,
      tokenEndpointAuthMethod,
    }
  }

  private selectTokenEndpointAuthMethod(
    configured: McpOAuthConfig['tokenEndpointAuthMethod'],
    supported: string[] | undefined
  ): 'client_secret_post' | 'none' {
    if (configured === 'client_secret_post' || configured === 'none') {
      return configured
    }

    if (Array.isArray(supported) && supported.length > 0) {
      if (supported.includes('client_secret_post')) return 'client_secret_post'
      if (supported.includes('none')) return 'none'
    }

    return this.oauth?.clientSecret ? 'client_secret_post' : 'none'
  }

  private async fetchFirstJson<T>(candidates: string[], rejectRedirects = false): Promise<{ value: T; url: string }> {
    const errors: string[] = []

    for (const candidate of candidates) {
      try {
        const value = await this.fetchJson<T>(candidate, rejectRedirects)
        return { value, url: candidate }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${candidate} -> ${message}`)
      }
    }

    throw new Error(`OAuth discovery failed: unable to fetch metadata from candidates. ${errors.join(' | ')}`)
  }

  private async fetchJson<T>(url: string, rejectRedirects = false): Promise<T> {
    const response = await fetch(url, {
      redirect: rejectRedirects ? 'error' : 'follow',
      signal: this.oauthAbortController?.signal,
      headers: {
        accept: 'application/json',
      },
    })

    const body = await response.text()
    if (!response.ok) {
      throw new Error(`OAuth metadata request failed (HTTP ${response.status})`)
    }

    try {
      return JSON.parse(body) as T
    } catch (error) {
      throw new Error('OAuth metadata endpoint returned invalid JSON')
    }
  }

  private async resolveOAuthClientCredentials(
    oauthMeta: {
      registrationEndpoint?: string
      tokenEndpointAuthMethod: 'client_secret_post' | 'none'
    },
    redirectUri: string
  ): Promise<{ clientId: string; clientSecret?: string; tokenEndpointAuthMethod: 'client_secret_post' | 'none'; clientMode: 'configured' | 'dynamic'; registeredRedirectUri?: string }> {
    if (this.oauth?.clientId && this.oauth.clientMode !== 'dynamic') {
      if (oauthMeta.tokenEndpointAuthMethod === 'none') {
        return {
          clientId: this.oauth.clientId,
          clientSecret: this.oauth.clientSecret,
          tokenEndpointAuthMethod: 'none',
          clientMode: 'configured',
        }
      }

      if (this.oauth.clientSecret) {
        return {
          clientId: this.oauth.clientId,
          clientSecret: this.oauth.clientSecret,
          tokenEndpointAuthMethod: 'client_secret_post',
          clientMode: 'configured',
        }
      }
    }

    return this.registerDynamicClient(oauthMeta.registrationEndpoint, redirectUri, oauthMeta.tokenEndpointAuthMethod)
  }

  private async registerDynamicClient(
    registrationEndpoint: string | undefined,
    redirectUri: string,
    tokenEndpointAuthMethod: 'client_secret_post' | 'none'
  ): Promise<{ clientId: string; clientSecret?: string; tokenEndpointAuthMethod: 'client_secret_post' | 'none'; clientMode: 'dynamic'; registeredRedirectUri: string }> {
    if (!registrationEndpoint) {
      throw new Error(
        'Authorization server does not expose dynamic client registration endpoint and no preregistered OAuth client credentials were supplied'
      )
    }

    const response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        client_name: `Ygg Chat MCP (${this.name})`,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      }),
    })

    const body = await response.text()
    if (!response.ok) {
      const policyHint = response.status === 401 || response.status === 403
        ? ' The authorization server requires a pre-registered OAuth client; configure a public client ID or confidential client credentials.'
        : ''
      throw new Error(
        `Dynamic client registration failed (${response.status} ${response.statusText}).${policyHint}${body ? ` Response: ${body.slice(0, 400)}` : ''}`
      )
    }

    const payload = JSON.parse(body) as {
      client_id?: string
      client_secret?: string
      token_endpoint_auth_method?: 'client_secret_post' | 'none'
    }

    if (!payload.client_id) {
      throw new Error('Dynamic client registration response missing client_id')
    }

    const resolvedAuthMethod = payload.token_endpoint_auth_method || tokenEndpointAuthMethod
    if (resolvedAuthMethod === 'client_secret_post' && !payload.client_secret) {
      throw new Error('Dynamic client registration response missing client_secret for client_secret_post auth')
    }

    return {
      clientId: payload.client_id,
      clientSecret: payload.client_secret,
      tokenEndpointAuthMethod: resolvedAuthMethod,
      clientMode: 'dynamic',
      registeredRedirectUri: redirectUri,
    }
  }

  private async exchangeAuthorizationCodeForToken(input: {
    code: string
    codeVerifier: string
    redirectUri: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
    tokenEndpointAuthMethod: 'client_secret_post' | 'none'
    resource: string
    omitResource: boolean
    signal?: AbortSignal
  }): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams()
    params.set('grant_type', 'authorization_code')
    params.set('code', input.code)
    params.set('redirect_uri', input.redirectUri)
    params.set('code_verifier', input.codeVerifier)
    params.set('client_id', input.clientId)
    if (input.tokenEndpointAuthMethod === 'client_secret_post') {
      if (!input.clientSecret) {
        throw new Error('Token exchange requires client_secret for client_secret_post auth')
      }
      params.set('client_secret', input.clientSecret)
    }
    if (!input.omitResource) params.set('resource', input.resource)

    const response = await fetch(input.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      signal: input.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: params.toString(),
    })

    const body = await response.text()
    if (!response.ok) {
      throw new Error(
        `Token exchange failed (HTTP ${response.status})`
      )
    }

    let token: OAuthTokenResponse
    try {
      token = JSON.parse(body) as OAuthTokenResponse
    } catch {
      throw new Error('OAuth token endpoint returned invalid JSON')
    }
    if (!token.access_token) {
      throw new Error('Token exchange response missing access_token')
    }

    return token
  }

  private async refreshOAuthToken(): Promise<void> {
    if (!this.oauth?.refreshToken || !this.oauth?.tokenEndpoint || !this.oauth?.clientId) {
      throw new Error('Missing OAuth refresh token configuration')
    }

    const authMethod = this.oauth.tokenEndpointAuthMethod || (this.oauth.clientSecret ? 'client_secret_post' : 'none')

    const params = new URLSearchParams()
    params.set('grant_type', 'refresh_token')
    params.set('refresh_token', this.oauth.refreshToken)
    params.set('client_id', this.oauth.clientId)

    if (authMethod === 'client_secret_post') {
      if (!this.oauth.clientSecret) {
        throw new Error('Missing clientSecret for OAuth refresh token request using client_secret_post')
      }
      params.set('client_secret', this.oauth.clientSecret)
    }

    const omitResource = shouldOmitLocalCelestialResource(this.config.url, this.oauth)
    if (this.oauth.resource && !omitResource) {
      params.set('resource', this.oauth.resource)
    }

    const response = await fetch(this.oauth.tokenEndpoint, {
      method: 'POST',
      redirect: 'error',
      signal: this.oauthAbortController?.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: params.toString(),
    })

    const body = await response.text()
    if (!response.ok) {
      throw new Error(
        `Refresh token request failed (HTTP ${response.status})`
      )
    }

    let token: OAuthTokenResponse
    try {
      token = JSON.parse(body) as OAuthTokenResponse
    } catch {
      throw new Error('OAuth token endpoint returned invalid JSON')
    }
    if (!token.access_token) {
      throw new Error('Refresh token response missing access_token')
    }

    this.oauthAbortController?.signal.throwIfAborted()
    this.oauth = {
      ...this.oauth,
      tokenEndpointAuthMethod: authMethod,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || this.oauth.refreshToken,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    }

    await this.persistOAuthState()
    this.lastOAuthError = undefined
  }

  private async persistOAuthState(): Promise<void> {
    if (!this.oauth) return
    this.config.oauth = { ...this.oauth }
    await this.onOAuthChanged?.({ ...this.oauth })
  }

  private async createOAuthCallbackServer(expectedState: string, configuredRedirectUri?: string, signal?: AbortSignal): Promise<{
    redirectUri: string
    waitForCode: (timeoutMs?: number) => Promise<string>
    close: () => Promise<void>
  }> {
    const callbackBinding = configuredRedirectUri ? parseMcpOAuthRedirectUri(configuredRedirectUri) : undefined
    const callbackPath = callbackBinding?.pathname || DEFAULT_OAUTH_CALLBACK_PATH
    let resolver: ((code: string) => void) | null = null
    let rejecter: ((err: Error) => void) | null = null

    const callbackPromise = new Promise<string>((resolve, reject) => {
      resolver = resolve
      rejecter = reject
    })

    // A callback may arrive while discovery/browser launch is still awaited.
    void callbackPromise.catch(() => undefined)
    let consumed = false
    const cancel = () => {
      consumed = true
      rejecter?.(new Error('OAuth authorization cancelled'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()

    const server: HttpServer = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || callbackPath, `http://${req.headers.host || '127.0.0.1'}`)
        if (requestUrl.pathname !== callbackPath) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Not found')
          return
        }

        if (consumed) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('OAuth callback already consumed')
          return
        }
        consumed = true

        const state = requestUrl.searchParams.get('state')
        const code = requestUrl.searchParams.get('code')
        const error = requestUrl.searchParams.get('error')

        if (!state || state !== expectedState) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Invalid OAuth state. You can close this tab and retry from the app.')
          rejecter?.(new Error('Invalid OAuth state received'))
          return
        }

        if (error) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('OAuth authorization failed. You can close this tab and retry from the app.')
          rejecter?.(new Error('OAuth authorization failed or was denied'))
          return
        }

        if (!code) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Missing authorization code. You can close this tab and retry from the app.')
          rejecter?.(new Error('OAuth callback missing authorization code'))
          return
        }

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body><h2>MCP authorization complete.</h2><p>You can close this tab and return to Ygg Chat.</p></body></html>')
        resolver?.(code)
      } catch (error) {
        rejecter?.(error instanceof Error ? error : new Error(String(error)))
      }
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(callbackBinding?.port || 0, callbackBinding?.hostname || '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    const address = server.address() as { port?: number } | null
    const port = address?.port
    if (!port) {
      server.close()
      throw new Error('Failed to start OAuth callback server')
    }

    return {
      redirectUri: callbackBinding?.redirectUri || `http://127.0.0.1:${port}${callbackPath}`,
      waitForCode: (timeoutMs = 5 * 60_000) =>
        new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            consumed = true
            rejecter?.(new Error('Timed out waiting for OAuth callback'))
          }, timeoutMs)

          callbackPromise
            .then(code => {
              clearTimeout(timeout)
              resolve(code)
            })
            .catch(error => {
              clearTimeout(timeout)
              reject(error)
            })
        }),
      close: async () => {
        signal?.removeEventListener('abort', cancel)
        cancel()
        await new Promise<void>(resolve => {
          server.close(() => resolve())
        })
      },
    }
  }

  private resolveJsonRpcFromSse(payload: string, expectedId: number | string): any {

    const events = payload.split(/\r?\n\r?\n/)
    const parsedEvents: any[] = []

    for (const event of events) {
      const lines = event.split(/\r?\n/)
      const dataLines = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(Boolean)

      if (dataLines.length === 0) continue

      const data = dataLines.join('\n')
      if (data === '[DONE]') continue

      try {
        parsedEvents.push(JSON.parse(data))
      } catch {
        // Ignore non-JSON SSE event payloads
      }
    }

    if (parsedEvents.length === 0) {
      throw new Error('MCP HTTP SSE response did not contain JSON payloads')
    }

    return this.resolveJsonRpcPayload(parsedEvents, expectedId)
  }

  private resolveJsonRpcPayload(payload: any, expectedId: number | string): any {
    const messages = Array.isArray(payload) ? payload : [payload]
    let fallbackResult: any = undefined

    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        continue
      }

      // Notification
      if ('method' in message && !('id' in message)) {
        this.handleNotification(message as JsonRpcNotification)
        continue
      }

      if ('id' in message) {
        if (message.id !== expectedId) {
          continue
        }

        if ('error' in message && message.error) {
          throw new Error(message.error.message || 'MCP request failed')
        }

        return message.result
      }

      if ('result' in message) {
        fallbackResult = message.result
      } else {
        fallbackResult = message
      }
    }

    if (fallbackResult !== undefined) {
      return fallbackResult
    }

    throw new Error('No matching JSON-RPC response found')
  }

  private sendNotification(method: string, params?: any): void {
    if (this.transport === 'http') {
      void this.sendHttpNotification(method, params)
      return
    }

    this.sendStdioNotification(method, params)
  }

  private sendStdioNotification(method: string, params?: any): void {
    if (!this.process?.stdin) return

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    }

    const message = this.encodeStdioMessage(notification)
    this.process.stdin.write(message)
  }

  private async sendHttpNotification(method: string, params?: any, allowAuthRetry = true): Promise<void> {
    if (!this.config.url) return

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    }

    try {
      await this.prepareHttpAuthentication()
      const headers = this.buildHttpHeaders()
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(notification),
      })

      const responseSessionId = response.headers.get('mcp-session-id')
      if (responseSessionId) {
        this.sessionId = responseSessionId
      }

      if (response.status === 401 && allowAuthRetry && await this.tryHandleHttpUnauthorized(response)) {
        await this.sendHttpNotification(method, params, false)
        return
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        console.warn(
          `[MCP:${this.name}] HTTP notification failed (${response.status} ${response.statusText})${body ? `: ${body.slice(0, 300)}` : ''}`
        )
      }
    } catch (error) {
      console.warn(`[MCP:${this.name}] HTTP notification error:`, error)
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  getStatus(): McpServerStatus {
    return {
      name: this.name,
      status: this.status,
      error: this.error,
      tools: this.tools,
      resources: this.resources,
      prompts: this.prompts,
      pid: this.process?.pid,
    }
  }
}

// ============================================================================
// MCP Manager - Orchestrates multiple MCP server connections
// ============================================================================

const MCP_CONFIG_FILE = 'mcp-servers.json'

interface McpConfigFile {
  settings?: {
    lazyStart?: boolean
  }
  servers?: Record<string, Omit<McpServerConfig, 'name'>>
  mcpServers?: Record<string, Omit<McpServerConfig, 'name'>> // Compatibility with .mcp.json format
}

export class McpManager extends EventEmitter {
  private clients: Map<string, McpClient> = new Map()
  private configPath: string = ''
  private initialized = false
  private initPromise: Promise<void> | null = null
  private settings: { lazyStart: boolean } = { lazyStart: true }
  private starts = new Map<string, Promise<void>>()
  private configWrites: Promise<unknown> = Promise.resolve()

  private serializeConfig<T>(work: () => Promise<T>): Promise<T> {
    const result = this.configWrites.then(() => withCredentialVaultLock(work, `${this.configPath}.lock`))
    this.configWrites = result.then(() => undefined, () => undefined)
    return result
  }

  getSettings(): { lazyStart: boolean } {
    return { ...this.settings }
  }

  getConfigDirectory(): string {
    // Injected host data directory (Electron userData or standalone YGG_DATA_DIR).
    const hostDataDir = tryGetServerConfig()?.dataDir
    if (hostDataDir) {
      return hostDataDir
    }
    return path.resolve(process.cwd(), '.ygg-chat-r')
  }

  getConfigPath(): string {
    return path.join(this.getConfigDirectory(), MCP_CONFIG_FILE)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._doInitialize()
    await this.initPromise
    this.initPromise = null
  }

  private async _doInitialize(): Promise<void> {
    this.configPath = this.getConfigPath()
    console.log('[McpManager] Initializing with config:', this.configPath)

    // Ensure config directory exists
    await fs.mkdir(path.dirname(this.configPath), { recursive: true })

    // Load configuration and migrate any legacy secrets, but never connect here.
    // Connecting an HTTP server performs MCP initialization/capability requests and
    // may launch interactive OAuth, which must only happen on explicit/model use.
    await this.loadConfig()

    this.initialized = true
    console.log('[McpManager] Initialized; servers will connect on first use')
  }

  private async loadConfig(): Promise<McpServerConfig[]> {
    const config = await this.loadConfigFile()
    // MCP connections are always lazy. Keep reading the legacy setting for config
    // compatibility, but do not allow it to trigger network/auth work at startup.
    this.settings = { lazyStart: true }

    const rawServers = (config.servers && Object.keys(config.servers).length > 0
      ? config.servers
      : config.mcpServers) || {}

    const configs = Object.entries(rawServers).map(([name, serverConfig]) => {
      const transport = resolveTransport(serverConfig)
      // Configuration reads never access Keychain. Retain legacy plaintext until
      // the selected server is used and its secure write has succeeded.
      const oauth = serverConfig.oauth ? { ...serverConfig.oauth } : undefined
      const headers = serverConfig.headers ? { ...serverConfig.headers } : undefined
      if (oauth?.accessToken && headers?.Authorization?.startsWith('Bearer ')) {
        delete headers.Authorization
      }

      return {
        name,
        enabled: serverConfig.enabled !== false,
        autoStart: serverConfig.autoStart,
        transport,
        type: transport,
        command: serverConfig.command,
        args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
        env: serverConfig.env,
        stdioFraming: serverConfig.stdioFraming,
        url: serverConfig.url,
        headers,
        oauth,
        credentialStorage: serverConfig.credentialStorage,
      }
    })
    return configs
  }

  private async loadConfigFile(): Promise<McpConfigFile> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8')
      const parsed: McpConfigFile = JSON.parse(content)
      const servers = parsed.servers || parsed.mcpServers || {}

      return {
        settings: parsed.settings,
        servers,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const defaultConfig: McpConfigFile = {
          settings: { lazyStart: true },
          servers: {},
        }
        await fs.writeFile(this.configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
        return defaultConfig
      }
      console.error('[McpManager] Failed to load config:', err)
      return { settings: { lazyStart: true }, servers: {} }
    }
  }

  private async saveConfig(configs: McpServerConfig[], settings?: { lazyStart?: boolean }, secretUpdates: string[] = []): Promise<void> {
    const configFile: McpConfigFile = {
      settings: settings ?? this.settings,
      servers: {},
    }

    for (const config of configs) {
      const transport = resolveTransport(config)
      if (secretUpdates.includes(config.name)) {
        await mcpOAuthSecretStore.save(config.name, extractOAuthSecrets(config.oauth))
      }
      configFile.servers![config.name] = {
        enabled: config.enabled,
        credentialStorage: secretUpdates.includes(config.name) ? 'vault' : config.credentialStorage,
        autoStart: config.autoStart,
        transport,
        type: transport,
        command: config.command,
        args: config.args,
        env: config.env,
        stdioFraming: config.stdioFraming,
        url: config.url,
        headers: config.headers,
        // Preserve un-migrated plaintext on unrelated metadata-only writes.
        oauth: secretUpdates.includes(config.name) ? stripOAuthSecrets(config.oauth) : config.oauth,
      }
    }

    const temporary = `${this.configPath}.${process.pid}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(configFile, null, 2), { encoding: 'utf-8', mode: 0o600 })
      await fs.rename(temporary, this.configPath)
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }

  private async persistClientConfig(name: string): Promise<void> {
    return this.serializeConfig(() => this.persistClientConfigUnlocked(name))
  }

  private async persistClientConfigUnlocked(name: string): Promise<void> {
    try {
      const client = this.clients.get(name)
      if (!client) return

      const configs = await this.loadConfig()
      const index = configs.findIndex(c => c.name === name)
      if (index === -1) return

      configs[index] = {
        ...configs[index],
        ...client.config,
        oauth: stripOAuthSecrets(client.config.oauth),
        credentialStorage: configs[index].credentialStorage,
        name: configs[index].name,
      }

      await this.saveConfig(configs, this.settings)
    } catch (error) {
      console.warn(`[McpManager] Failed to persist runtime config for ${name}:`, error)
    }
  }

  /** Called only by the user-initiated credential consolidation action. */
  async consolidatePlaintextCredentials(): Promise<void> {
    return this.serializeConfig(() => this.consolidatePlaintextCredentialsUnlocked())
  }

  private async consolidatePlaintextCredentialsUnlocked(): Promise<void> {
    const configs = await this.loadConfig()
    for (const config of configs) {
      if (hasOAuthSecrets(config.oauth)) {
        await mcpOAuthSecretStore.importLegacy(config.name, extractOAuthSecrets(config.oauth))
        config.oauth = stripOAuthSecrets(config.oauth)
      }
      if (resolveTransport(config) === 'http' && config.credentialStorage !== 'anonymous') config.credentialStorage = 'vault'
    }
    await this.saveConfig(configs, this.settings)
  }

  async updateSettings(_updates: { lazyStart?: boolean }): Promise<{ lazyStart: boolean }> {
    return this.serializeConfig(async () => {
      const configs = await this.loadConfig()
      this.settings = { lazyStart: true }
      await this.saveConfig(configs, this.settings)
      return this.getSettings()
    })
  }

  async startServer(config: McpServerConfig): Promise<void> {
    const pending = this.starts.get(config.name)
    if (pending) return pending
    const operation = this.connectServer(config)
    this.starts.set(config.name, operation)
    try { await operation } finally { if (this.starts.get(config.name) === operation) this.starts.delete(config.name) }
  }

  private async connectServer(config: McpServerConfig): Promise<void> {
    // Check if already running
    const existing = this.clients.get(config.name)
    if (existing && existing.status === 'connected') {
      console.log(`[McpManager] Server ${config.name} already connected`)
      return
    }

    const transport = resolveTransport(config)
    const normalizedConfig: McpServerConfig = {
      ...config,
      transport,
      type: transport,
      args: Array.isArray(config.args) ? config.args : [],
      stdioFraming: resolveStdioFraming(config),
    }

    if (transport === 'http' && !normalizedConfig.url) {
      throw new Error(`MCP server '${config.name}' is configured for HTTP but missing url`)
    }

    if (transport === 'stdio' && !normalizedConfig.command) {
      throw new Error(`MCP server '${config.name}' is configured for stdio but missing command`)
    }

    if (transport === 'http' && config.credentialStorage !== 'anonymous') {
      let storedSecrets: McpOAuthSecrets = {}
      if (hasOAuthSecrets(config.oauth)) {
        await mcpOAuthSecretStore.importLegacy(config.name, extractOAuthSecrets(config.oauth))
      }
      // Old entries without a storage marker are ambiguous: do not silently
      // discard possible legacy credentials and fall back to anonymous OAuth.
      storedSecrets = await mcpOAuthSecretStore.load(config.name, config.credentialStorage !== 'vault' && !hasOAuthSecrets(config.oauth))
      normalizedConfig.oauth = config.oauth || Object.keys(storedSecrets).length
        ? { ...stripOAuthSecrets(config.oauth), ...storedSecrets } : undefined
      if (normalizedConfig.oauth?.accessToken && normalizedConfig.headers?.Authorization?.startsWith('Bearer ')) {
        normalizedConfig.headers = { ...normalizedConfig.headers }
        delete normalizedConfig.headers.Authorization
      }
      if (hasOAuthSecrets(config.oauth)) {
        await this.serializeConfig(async () => {
          const configs = await this.loadConfig()
          const index = configs.findIndex(item => item.name === config.name)
          if (index !== -1) {
            configs[index] = { ...configs[index], oauth: stripOAuthSecrets(normalizedConfig.oauth), credentialStorage: 'vault' }
            await this.saveConfig(configs, this.settings)
          }
        })
      }
    }

    // Create and connect client
    let client: McpClient
    client = new McpClient(
      config.name,
      normalizedConfig,
      async oauth => {
        normalizedConfig.oauth = { ...oauth }
        await this.serializeConfig(async () => {
          const configs = await this.loadConfig()
          const index = configs.findIndex(item => item.name === config.name)
          if (index !== -1 && this.clients.get(config.name) === client) {
            configs[index] = { ...configs[index], ...client.config, oauth: { ...oauth }, credentialStorage: 'vault', name: config.name }
            await this.saveConfig(configs, this.settings, [config.name])
          }
        })
      },
      tools => {
        this.emit('toolsChanged', {
          serverName: config.name,
          tools: tools.map(tool => ({ ...tool })),
        } satisfies McpToolsChangedEvent)
      }
    )

    client.on('statusChange', (status) => {
      this.emit('serverStatusChange', { name: config.name, status })
    })

    this.clients.set(config.name, client)
    await client.connect()
    await this.persistClientConfig(config.name)
  }

  async stopServer(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      await client.disconnect()
      this.clients.delete(name)
    }
  }

  async restartServer(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      await client.disconnect()
      await client.connect()
    }
  }

  async addServer(config: McpServerConfig): Promise<void> {
    return this.serializeConfig(() => this.addServerUnlocked(config))
  }

  private async addServerUnlocked(config: McpServerConfig): Promise<void> {
    // Load current configs
    const configs = await this.loadConfig()

    // Check for duplicate
    if (configs.some(c => c.name === config.name)) {
      throw new Error(`Server '${config.name}' already exists`)
    }

    const transport = resolveTransport(config)
    const normalizedConfig: McpServerConfig = {
      ...config,
      transport,
      type: transport,
      args: Array.isArray(config.args) ? config.args : [],
      stdioFraming: resolveStdioFraming(config),
    }

    shouldOmitLocalCelestialResource(normalizedConfig.url, normalizedConfig.oauth, false)
    normalizedConfig.credentialStorage = config.oauth ? 'vault' : 'anonymous'
    configs.push(normalizedConfig)
    await this.saveConfig(configs, this.settings, hasOAuthSecrets(config.oauth) ? [config.name] : [])

    // Connections are intentionally deferred until an explicit start or MCP use.
    // In particular, adding an OAuth-backed server must not open a browser.
  }

  async updateServer(name: string, updates: Partial<McpServerConfig>): Promise<void> {
    const client = this.clients.get(name)
    const wasConnected = client?.status === 'connected'
    if (client) {
      await this.stopServer(name)
      await client.waitForOAuthCompletion()
    }
    const config = await this.serializeConfig(() => this.updateServerUnlocked(name, updates))
    if (wasConnected) await this.startServer(config)
  }

  private async updateServerUnlocked(name: string, updates: Partial<McpServerConfig>): Promise<McpServerConfig> {
    const configs = await this.loadConfig()
    const index = configs.findIndex(c => c.name === name)

    if (index === -1) {
      throw new Error(`Server '${name}' not found`)
    }

    const existing = configs[index]
    const oauthUpdates = updates.oauth
      ? Object.fromEntries(Object.entries(updates.oauth).filter(([, value]) => value !== undefined))
      : undefined
    const merged = {
      ...existing,
      ...updates,
      oauth: oauthUpdates ? { ...existing.oauth, ...oauthUpdates } : existing.oauth,
    }
    shouldOmitLocalCelestialResource(merged.url, merged.oauth, false)
    const approvalChanged = existing.url !== merged.url || existing.oauth?.clientId !== merged.oauth?.clientId ||
      existing.oauth?.authorizationServer !== merged.oauth?.authorizationServer ||
      Boolean(existing.oauth?.allowMissingPkceS256ForCelestialTest) !== Boolean(merged.oauth?.allowMissingPkceS256ForCelestialTest) ||
      Boolean(existing.oauth?.omitResourceForLocalCelestialTest) !== Boolean(merged.oauth?.omitResourceForLocalCelestialTest)
    if (approvalChanged && merged.oauth) {
      // Do not reuse credentials/endpoints obtained under a previous compatibility decision.
      merged.oauth = {
        ...merged.oauth,
        accessToken: undefined,
        refreshToken: undefined,
        expiresAt: undefined,
        authorizationEndpoint: undefined,
        tokenEndpoint: undefined,
        registrationEndpoint: undefined,
        registeredRedirectUri: undefined,
      }
      if ((merged.oauth.allowMissingPkceS256ForCelestialTest === true || merged.oauth.omitResourceForLocalCelestialTest === true) && merged.oauth.tokenEndpointAuthMethod === 'none') {
        merged.oauth.clientSecret = undefined
      }
    }
    if (oauthUpdates?.accessToken && oauthUpdates.expiresAt === undefined) {
      merged.oauth = { ...merged.oauth, expiresAt: undefined }
    }
    const transport = resolveTransport(merged)
    configs[index] = {
      ...merged,
      transport,
      type: transport,
      args: Array.isArray(merged.args) ? merged.args : [],
      stdioFraming: resolveStdioFraming(merged),
    }

    const secretPatch = extractOAuthSecrets(updates.oauth)
    const changesSecrets = approvalChanged || Object.values(secretPatch).some(value => value !== undefined)
    if (changesSecrets) {
      if (hasOAuthSecrets(existing.oauth)) await mcpOAuthSecretStore.importLegacy(name, extractOAuthSecrets(existing.oauth))
      const next: McpOAuthSecrets = Object.fromEntries(Object.entries(secretPatch).filter(([, value]) => value !== undefined))
      if (approvalChanged) {
        next.accessToken = undefined
        next.refreshToken = undefined
        if (merged.oauth?.clientSecret === undefined && merged.oauth?.tokenEndpointAuthMethod === 'none') next.clientSecret = undefined
      }
      await mcpOAuthSecretStore.patch(name, next)
      configs[index].oauth = stripOAuthSecrets(configs[index].oauth)
      configs[index].credentialStorage = 'vault'
    }
    await this.saveConfig(configs, this.settings)

    return configs[index]
  }

  async removeServer(name: string): Promise<void> {
    // Stop if running
    await this.stopServer(name)

    await this.serializeConfig(async () => {
      const configs = await this.loadConfig()
      const filtered = configs.filter(c => c.name !== name)
      await mcpOAuthSecretStore.clear(name)
      await this.saveConfig(filtered, this.settings)
    })
  }

  // ============================================================================
  // Tool operations
  // ============================================================================

  getAllTools(): McpToolDefinition[] {
    const tools: McpToolDefinition[] = []
    for (const client of this.clients.values()) {
      if (client.status === 'connected') {
        tools.push(...client.tools)
      }
    }
    return tools
  }

  private async ensureServerConnected(serverName: string): Promise<McpClient> {
    const existing = this.clients.get(serverName)
    if (existing && existing.status === 'connected') {
      return existing
    }

    const configs = await this.loadConfig()
    const config = configs.find(c => c.name === serverName)
    if (!config) {
      throw new Error(`MCP server '${serverName}' not found`)
    }
    if (!config.enabled) {
      throw new Error(`MCP server '${serverName}' is disabled`)
    }

    await this.startServer(config)
    const client = this.clients.get(serverName)
    if (!client || client.status !== 'connected') {
      throw new Error(`MCP server '${serverName}' failed to connect`)
    }
    return client
  }

  async callTool(qualifiedName: string, args: any): Promise<McpToolCallResult> {
    // Parse qualified name: mcp__serverName__toolName
    const match = qualifiedName.match(/^mcp__([^_]+)__(.+)$/)
    if (!match) {
      throw new Error(`Invalid MCP tool name: ${qualifiedName}. Expected format: mcp__serverName__toolName`)
    }

    const [, serverName, toolName] = match
    return this.callServerTool(serverName, toolName, args)
  }

  async callServerTool(serverName: string, toolName: string, args: any): Promise<McpToolCallResult> {
    const client = await this.ensureServerConnected(serverName)
    return client.callTool(toolName, args)
  }

  // Check if a tool name is an MCP tool
  isMcpTool(name: string): boolean {
    return name.startsWith('mcp__')
  }

  // ============================================================================
  // Resource operations
  // ============================================================================

  getAllResources(): McpResourceDefinition[] {
    const resources: McpResourceDefinition[] = []
    for (const client of this.clients.values()) {
      if (client.status === 'connected') {
        resources.push(...client.resources)
      }
    }
    return resources
  }

  async readResource(serverName: string, uri: string): Promise<any> {
    const client = await this.ensureServerConnected(serverName)
    return client.readResource(uri)
  }

  // ============================================================================
  // Prompt operations
  // ============================================================================

  getAllPrompts(): McpPromptDefinition[] {
    const prompts: McpPromptDefinition[] = []
    for (const client of this.clients.values()) {
      if (client.status === 'connected') {
        prompts.push(...client.prompts)
      }
    }
    return prompts
  }

  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>): Promise<any> {
    const client = await this.ensureServerConnected(serverName)
    return client.getPrompt(promptName, args)
  }

  // ============================================================================
  // Status
  // ============================================================================

  getStatus(): McpServerStatus[] {
    return Array.from(this.clients.values()).map(c => c.getStatus())
  }

  getServerStatus(name: string): McpServerStatus | undefined {
    return this.clients.get(name)?.getStatus()
  }

  async getConfigs(): Promise<McpServerConfig[]> {
    return await this.loadConfig()
  }

  // ============================================================================
  // Shutdown
  // ============================================================================

  async shutdown(): Promise<void> {
    console.log('[McpManager] Shutting down all MCP servers...')
    const promises = Array.from(this.clients.keys()).map(name => this.stopServer(name))
    await Promise.all(promises)
    console.log('[McpManager] All MCP servers stopped')
  }
}

// Singleton export
export const mcpManager = new McpManager()
