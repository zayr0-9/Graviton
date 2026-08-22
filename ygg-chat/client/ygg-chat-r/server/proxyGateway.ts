import crypto from 'crypto'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Express, Request, Response } from 'express'
type ProviderCredentialRecord = {
  user_id: string
  provider: string
  refresh_token: string
  client_id?: string | null
  client_secret?: string | null
  token_url?: string | null
  scopes?: string[] | null
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type JsonObject = Record<string, any>

interface ProxyRequestBody {
  provider?: string
  action?: string
  params?: JsonObject | string | null
  tenantId?: string
  toolName?: string
}

interface ProviderActionSpec {
  method: HttpMethod
  path: string
  queryParams?: string[]
  bodyParams?: string[]
  allowedParams?: string[]
  blockedParams?: string[]
  requiredScopes?: string[]
  rateLimitPerMinute?: number
  responseType?: 'json' | 'text'
}

interface ProviderAdapter {
  name: string
  actions: Record<string, ProviderActionSpec>
  resolveBaseUrl: (context: AdapterContext) => string
  defaultHeaders?: Record<string, string>
}

interface AdapterContext {
  provider: string
  tenantId: string
  action: string
  params: JsonObject
  credentials: ProviderCredentials
}

interface ProviderPolicy {
  requiredScopes?: string[]
  blockedParams?: string[]
  rateLimitPerMinute?: number
  allowedActions?: string[]
}

interface PolicyOptions {
  enforceScopes?: boolean
  blockedParams?: string[]
}

type CredentialSource = 'supabase' | 'file' | 'memory'

interface ProxyGatewayOptions {
  apiKey?: string
  adminApiKey?: string
  jwtSecret?: string
  sessionToken?: string
  allowInsecure?: boolean
  defaultRateLimitPerMinute?: number
  rateLimitPrefix?: string
  credentialsDir?: string
  credentialsSource?: CredentialSource
  adapters?: Record<string, ProviderAdapter>
  providerPolicies?: Record<string, ProviderPolicy>
  credentialVault?: CredentialVault
  policy?: PolicyOptions
}

type OAuth2Credentials = {
  type: 'oauth2'
  clientId: string
  clientSecret: string
  refreshToken: string
  tokenUrl: string
  scopes?: string[]
  accessToken?: string
  accessTokenExpiresAt?: number
}

type ClientCredentials = {
  type: 'client_credentials'
  clientId: string
  clientSecret: string
  tokenUrl: string
  scopes?: string[]
  accessToken?: string
  accessTokenExpiresAt?: number
}

type ApiKeyCredentials = {
  type: 'api_key'
  apiKey: string
  headerName?: string
  queryParam?: string
}

type BearerCredentials = {
  type: 'bearer'
  token: string
  expiresAt?: number
}

type ServiceAccountCredentials = {
  type: 'service_account'
  clientEmail: string
  privateKey: string
  tokenUrl: string
  scopes?: string[]
  accessToken?: string
  accessTokenExpiresAt?: number
}

type ProviderCredentials =
  | OAuth2Credentials
  | ClientCredentials
  | ApiKeyCredentials
  | BearerCredentials
  | ServiceAccountCredentials

interface CredentialVault {
  get: (tenantId: string, provider: string) => Promise<ProviderCredentials | undefined>
  set: (tenantId: string, provider: string, credentials: ProviderCredentials) => Promise<void>
  delete: (tenantId: string, provider: string) => Promise<void>
}

class InMemoryCredentialVault implements CredentialVault {
  private store = new Map<string, ProviderCredentials>()

  async get(tenantId: string, provider: string): Promise<ProviderCredentials | undefined> {
    return this.store.get(`${tenantId}:${provider}`)
  }

  async set(tenantId: string, provider: string, credentials: ProviderCredentials): Promise<void> {
    this.store.set(`${tenantId}:${provider}`, credentials)
  }

  async delete(tenantId: string, provider: string): Promise<void> {
    this.store.delete(`${tenantId}:${provider}`)
  }
}

interface CredentialCacheEntry {
  credentials: ProviderCredentials
  mtimeMs: number
  sourcePath: string
}

class FileCredentialVault implements CredentialVault {
  private cache = new Map<string, CredentialCacheEntry>()

  constructor(private baseDir: string) {
    this.ensureBaseDir()
  }

  async get(tenantId: string, provider: string): Promise<ProviderCredentials | undefined> {
    const cacheKey = `${tenantId}:${provider}`
    const candidates = this.getCandidatePaths(tenantId, provider)
    const cached = this.cache.get(cacheKey)

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue
      }

      try {
        const stat = fs.statSync(candidate)
        if (cached && cached.sourcePath === candidate && cached.mtimeMs === stat.mtimeMs) {
          return cached.credentials
        }

        const raw = fs.readFileSync(candidate, 'utf8')
        const parsed = JSON.parse(raw)
        const normalized = normalizeCredentialPayload(provider, parsed)
        if (!normalized) {
          continue
        }

        this.cache.set(cacheKey, { credentials: normalized, mtimeMs: stat.mtimeMs, sourcePath: candidate })
        return normalized
      } catch (error) {
        logProxyEvent('warn', 'credentials_file_read_failed', {
          provider,
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        })
        return cached?.credentials
      }
    }

    return cached?.credentials
  }

  async set(tenantId: string, provider: string, credentials: ProviderCredentials): Promise<void> {
    this.ensureBaseDir()
    const tenantDir = path.join(this.baseDir, tenantId)
    fs.mkdirSync(tenantDir, { recursive: true })
    const filePath = path.join(tenantDir, `${provider}.json`)
    fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2), 'utf8')

    const stat = fs.statSync(filePath)
    this.cache.set(`${tenantId}:${provider}`, {
      credentials,
      mtimeMs: stat.mtimeMs,
      sourcePath: filePath,
    })
  }

  async delete(tenantId: string, provider: string): Promise<void> {
    const filePath = path.join(this.baseDir, tenantId, `${provider}.json`)
    this.cache.delete(`${tenantId}:${provider}`)

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (error) {
      logProxyEvent('warn', 'credentials_file_delete_failed', {
        provider,
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private getCandidatePaths(tenantId: string, provider: string): string[] {
    return [
      path.join(this.baseDir, tenantId, `${provider}.json`),
      path.join(this.baseDir, `${provider}.json`),
    ]
  }

  private ensureBaseDir(): void {
    if (!this.baseDir) return
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true })
    }
  }
}

class SupabaseCredentialVault implements CredentialVault {
  private fallback = new InMemoryCredentialVault()
  private warned = false

  private warnOnce(): void {
    if (this.warned) return
    this.warned = true
    logProxyEvent('warn', 'supabase_credentials_disabled_in_client_repo', {
      reason: 'server credential table module is not available in client-only repository',
      fallback: 'memory',
    })
  }

  async get(tenantId: string, provider: string): Promise<ProviderCredentials | undefined> {
    this.warnOnce()
    return this.fallback.get(tenantId, provider)
  }

  async set(tenantId: string, provider: string, credentials: ProviderCredentials): Promise<void> {
    this.warnOnce()
    await this.fallback.set(tenantId, provider, credentials)
  }

  async delete(tenantId: string, provider: string): Promise<void> {
    this.warnOnce()
    await this.fallback.delete(tenantId, provider)
  }
}

interface RateLimiterResult {
  allowed: boolean
  remaining: number
  resetAt: number
  source: 'redis' | 'memory'
}

interface RateLimiterAdapter {
  check: (key: string, limitOverride?: number) => Promise<RateLimiterResult>
}

interface RedisRateLimiterClient {
  status?: string
  eval: (
    script: string,
    numKeys: number,
    ...args: string[]
  ) => Promise<[number | string, number | string]>
}

class InMemoryRateLimiter implements RateLimiterAdapter {
  private buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(private defaultLimit: number, private windowMs: number) {}

  async check(key: string, limitOverride?: number): Promise<RateLimiterResult> {
    const limit = limitOverride ?? this.defaultLimit
    const now = Date.now()
    const existing = this.buckets.get(key)
    if (!existing || now >= existing.resetAt) {
      const resetAt = now + this.windowMs
      this.buckets.set(key, { count: 1, resetAt })
      return { allowed: true, remaining: Math.max(0, limit - 1), resetAt, source: 'memory' }
    }

    if (existing.count >= limit) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt, source: 'memory' }
    }

    existing.count += 1
    this.buckets.set(key, existing)
    return { allowed: true, remaining: Math.max(0, limit - existing.count), resetAt: existing.resetAt, source: 'memory' }
  }
}

class RedisRateLimiter implements RateLimiterAdapter {
  private fallback: InMemoryRateLimiter

  constructor(
    private client: RedisRateLimiterClient | null,
    private defaultLimit: number,
    private windowMs: number,
    private prefix: string
  ) {
    this.fallback = new InMemoryRateLimiter(defaultLimit, windowMs)
  }

  async check(key: string, limitOverride?: number): Promise<RateLimiterResult> {
    const limit = normalizeLimit(limitOverride ?? this.defaultLimit, this.defaultLimit)
    if (!this.client || !isRedisReady(this.client)) {
      return this.fallback.check(key, limit)
    }

    const redisKey = `${this.prefix}${key}`

    try {
      const result = (await this.client.eval(
        RATE_LIMIT_SCRIPT,
        1,
        redisKey,
        String(this.windowMs)
      )) as [number | string, number | string]

      const count = Number(result?.[0] ?? 0)
      const ttlMs = Number(result?.[1] ?? this.windowMs)
      const remainingMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.windowMs
      const resetAt = Date.now() + remainingMs
      const remaining = Math.max(0, limit - count)
      const allowed = count <= limit

      return { allowed, remaining, resetAt, source: 'redis' }
    } catch (error) {
      if (!warnedAboutRedisLimiter) {
        warnedAboutRedisLimiter = true
        logProxyEvent('warn', 'redis_rate_limit_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return this.fallback.check(key, limit)
    }
  }
}

class PolicyEngine {
  private enforceScopes: boolean
  private blockedParams: Set<string>

  constructor(options?: PolicyOptions) {
    this.enforceScopes = options?.enforceScopes ?? true
    const combinedBlocked = new Set<string>(DEFAULT_BLOCKED_PARAMS)
    if (options?.blockedParams) {
      options.blockedParams.forEach(param => combinedBlocked.add(param.toLowerCase()))
    }
    this.blockedParams = combinedBlocked
  }

  validate(options: {
    provider: string
    action: string
    params: JsonObject
    credentials: ProviderCredentials
    actionSpec: ProviderActionSpec
    providerPolicy?: ProviderPolicy
    pathParams: string[]
  }): string | null {
    const {
      params,
      credentials,
      actionSpec,
      providerPolicy,
      action,
      pathParams,
    } = options

    if (providerPolicy?.allowedActions && !providerPolicy.allowedActions.includes(action)) {
      return `Action ${action} is not allowed for provider`
    }

    const blockedParams = new Set<string>(this.blockedParams)
    if (providerPolicy?.blockedParams) {
      providerPolicy.blockedParams.forEach(param => blockedParams.add(param.toLowerCase()))
    }
    if (actionSpec.blockedParams) {
      actionSpec.blockedParams.forEach(param => blockedParams.add(param.toLowerCase()))
    }

    for (const key of Object.keys(params)) {
      if (blockedParams.has(key.toLowerCase())) {
        return `Parameter ${key} is not allowed`
      }
    }

    const allowedParams = new Set<string>()
    ;(actionSpec.allowedParams ?? []).forEach(param => allowedParams.add(param))
    ;(actionSpec.queryParams ?? []).forEach(param => allowedParams.add(param))
    ;(actionSpec.bodyParams ?? []).forEach(param => allowedParams.add(param))
    pathParams.forEach(param => allowedParams.add(param))

    if (allowedParams.size > 0) {
      for (const key of Object.keys(params)) {
        if (!allowedParams.has(key)) {
          return `Parameter ${key} is not on the allowlist`
        }
      }
    } else if (Object.keys(params).length > 0) {
      return 'This action does not allow parameters'
    }

    const requiredScopes = [...(providerPolicy?.requiredScopes ?? []), ...(actionSpec.requiredScopes ?? [])]
    if (this.enforceScopes && requiredScopes.length > 0) {
      const credentialScopes = getCredentialScopes(credentials)
      if (!credentialScopes) {
        return 'No scopes are stored for these credentials'
      }
      for (const scope of requiredScopes) {
        if (!credentialScopes.includes(scope)) {
          return `Missing required scope: ${scope}`
        }
      }
    }

    return null
  }
}

interface AuthResult {
  ok: boolean
  status: number
  error?: string
  tenantId?: string
  authType?: 'api_key' | 'jwt' | 'session' | 'insecure'
}

interface ProxyResponsePayload {
  ok: boolean
  status: number
  provider: string
  action: string
  requestId: string
  data: any
  headers?: Record<string, string>
}

const DEFAULT_RATE_LIMIT_PER_MINUTE = 60
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000
const DEFAULT_TOKEN_REFRESH_SKEW_MS = 60 * 1000
const DEFAULT_BLOCKED_PARAMS = ['access_token', 'refresh_token', 'client_secret', 'private_key', 'id_token', 'assertion']
const DEFAULT_RATE_LIMIT_PREFIX = 'rl:proxy:'
const DEFAULT_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DEFAULT_CREDENTIALS_DIR = path.join(os.homedir(), '.config', 'graviton', 'proxy-credentials')
const DEFAULT_CREDENTIALS_SOURCE: CredentialSource = 'file'
const RATE_LIMIT_SCRIPT = `
  local key = KEYS[1]
  local windowMs = tonumber(ARGV[1])
  local count = redis.call('INCR', key)
  if count == 1 then
    redis.call('PEXPIRE', key, windowMs)
  end
  local ttl = redis.call('PTTL', key)
  return {count, ttl}
`

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'x-request-id',
  'x-correlation-id',
  'x-rate-limit-remaining',
  'x-rate-limit-reset',
  'retry-after',
])

const PROXY_LOG_PREFIX = '[ProxyGateway]'

let warnedAboutInsecureAuth = false
let warnedAboutRedisLimiter = false

const DEFAULT_PROVIDER_POLICIES: Record<string, ProviderPolicy> = {
  google_drive: {
    requiredScopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
  gmail: {
    requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
}

const DEFAULT_ADAPTERS = createDefaultAdapters()

class ProxyGateway {
  private apiKey?: string
  private adminApiKey?: string
  private jwtSecret?: string
  private sessionToken?: string
  private allowInsecure: boolean
  private rateLimiter: RateLimiterAdapter
  private adapters: Record<string, ProviderAdapter>
  private providerPolicies: Record<string, ProviderPolicy>
  private credentialVault: CredentialVault
  private policyEngine: PolicyEngine

  constructor(options?: ProxyGatewayOptions) {
    this.apiKey = options?.apiKey ?? process.env.YGG_PROXY_API_KEY ?? undefined
    this.adminApiKey = options?.adminApiKey ?? process.env.YGG_PROXY_ADMIN_API_KEY ?? undefined
    this.jwtSecret = options?.jwtSecret ?? process.env.YGG_PROXY_JWT_SECRET ?? undefined
    this.sessionToken = options?.sessionToken ?? process.env.YGG_PROXY_SESSION_TOKEN ?? undefined
    this.allowInsecure = options?.allowInsecure ?? process.env.YGG_PROXY_ALLOW_INSECURE === 'true'

    const defaultLimit = options?.defaultRateLimitPerMinute ?? readEnvInt('YGG_PROXY_RATE_LIMIT_PER_MINUTE')
    const rateLimit: number = (defaultLimit !== undefined && Number.isFinite(defaultLimit) && defaultLimit > 0)
      ? defaultLimit
      : DEFAULT_RATE_LIMIT_PER_MINUTE
    const rateLimitPrefix = options?.rateLimitPrefix ?? process.env.YGG_PROXY_RATE_LIMIT_PREFIX ?? DEFAULT_RATE_LIMIT_PREFIX
    // Electron local server should not require Redis. Use in-memory limiter unconditionally.
    this.rateLimiter = new RedisRateLimiter(null, rateLimit, DEFAULT_RATE_LIMIT_WINDOW_MS, rateLimitPrefix)

    this.adapters = { ...DEFAULT_ADAPTERS, ...(options?.adapters ?? {}) }
    this.providerPolicies = { ...DEFAULT_PROVIDER_POLICIES, ...(options?.providerPolicies ?? {}) }
    this.credentialVault = options?.credentialVault ?? this.createCredentialVault(options)
    this.policyEngine = new PolicyEngine(options?.policy)
  }

  private createCredentialVault(options?: ProxyGatewayOptions): CredentialVault {
    const source =
      options?.credentialsSource ??
      (process.env.YGG_PROXY_CREDENTIALS_SOURCE as CredentialSource | undefined) ??
      DEFAULT_CREDENTIALS_SOURCE

    if (source === 'supabase' && !hasSupabaseConfig()) {
      logProxyEvent('warn', 'supabase_credentials_unavailable', {
        reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
      })
      return this.createFileVault(options)
    }

    if (source === 'file') {
      return this.createFileVault(options)
    }

    if (source === 'memory') {
      return new InMemoryCredentialVault()
    }

    return new SupabaseCredentialVault()
  }

  private createFileVault(options?: ProxyGatewayOptions): CredentialVault {
    const credentialsDir =
      options?.credentialsDir ?? process.env.YGG_PROXY_CREDENTIALS_DIR ?? DEFAULT_CREDENTIALS_DIR
    return new FileCredentialVault(credentialsDir)
  }

  register(app: Express): void {
    const router = express.Router()

    router.get('/proxy/providers', (_req, res) => {
      const providers = Object.keys(this.adapters).map(provider => ({
        provider,
        actions: Object.keys(this.adapters[provider].actions),
      }))
      res.json({ providers })
    })

    router.post('/proxy', (req, res) => {
      this.handleProxy(req, res)
    })

    router.post('/proxy/:provider/:action', (req, res) => {
      const body = (req.body ?? {}) as ProxyRequestBody
      body.provider = body.provider ?? req.params.provider
      body.action = body.action ?? req.params.action
      req.body = body
      this.handleProxy(req, res)
    })

    router.post('/proxy/credentials', (req, res) => {
      this.handleCredentialUpsert(req, res)
    })

    router.delete('/proxy/credentials', (req, res) => {
      this.handleCredentialDelete(req, res)
    })

    app.use('/api', router)
  }

  private handleProxy = async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now()
    const requestId = crypto.randomUUID()

    try {
      const auth = this.authenticateRequest(req)
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error })
        return
      }

      const body = (req.body ?? {}) as ProxyRequestBody
      const provider = body.provider?.trim()
      const action = body.action?.trim()
      if (!provider || !action) {
        res.status(400).json({ error: 'provider and action are required' })
        return
      }

      const adapter = this.adapters[provider]
      if (!adapter) {
        res.status(400).json({ error: `Unknown provider: ${provider}` })
        return
      }

      let params: JsonObject
      try {
        params = normalizeParams(body.params)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid params'
        res.status(400).json({ error: message })
        return
      }

      const tenantId = resolveTenantId(req, body, auth)
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required' })
        return
      }

      const toolName = resolveToolName(req, body)
      const actionSpec = adapter.actions[action]
      if (!actionSpec) {
        res.status(400).json({ error: `Unknown action: ${action}` })
        return
      }

      const pathParams = extractPathParams(actionSpec.path)
      const missingParam = pathParams.find(param => params[param] === undefined)
      if (missingParam) {
        res.status(400).json({ error: `Missing path parameter: ${missingParam}` })
        return
      }

      const credentials = await this.credentialVault.get(tenantId, provider)
      if (!credentials) {
        res.status(401).json({ error: `No credentials stored for ${provider}` })
        return
      }

      const policyError = this.policyEngine.validate({
        provider,
        action,
        params,
        credentials,
        actionSpec,
        providerPolicy: this.providerPolicies[provider],
        pathParams,
      })
      if (policyError) {
        res.status(403).json({ error: policyError })
        return
      }

      const rateLimitKey = [tenantId, provider, action, toolName].filter(Boolean).join(':')
      const rateLimit = await this.rateLimiter.check(
        rateLimitKey,
        actionSpec.rateLimitPerMinute ?? this.providerPolicies[provider]?.rateLimitPerMinute
      )
      if (!rateLimit.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000))
        res.set('Retry-After', String(retryAfterSeconds))
        res.status(429).json({
          error: 'Rate limit exceeded',
          resetAt: rateLimit.resetAt,
        })
        return
      }

      const ctx: AdapterContext = { provider, tenantId, action, params, credentials }
      const { url, method, headers, body: requestBody } = await buildProviderRequest(
        adapter,
        actionSpec,
        ctx,
        this.credentialVault
      )

      const upstream = await forwardRequest({
        url,
        method,
        headers,
        body: requestBody,
        responseType: actionSpec.responseType,
      })

      logProxyEvent('info', 'request_complete', {
        requestId,
        provider,
        action,
        tenantId,
        toolName,
        status: upstream.status,
        ok: upstream.ok,
        latencyMs: Date.now() - startTime,
        paramKeys: Object.keys(params),
        rateLimitSource: rateLimit.source,
      })

      const payload: ProxyResponsePayload = {
        ok: upstream.ok,
        status: upstream.status,
        provider,
        action,
        requestId,
        data: upstream.data,
        headers: upstream.headers,
      }

      res.status(upstream.status).json(payload)
    } catch (error) {
      logProxyEvent('error', 'request_failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
      res.status(500).json({ error: 'Proxy request failed', requestId })
    }
  }

  private handleCredentialUpsert = async (req: Request, res: Response): Promise<void> => {
    const authorized = this.authorizeAdmin(req)
    if (!authorized.ok) {
      res.status(authorized.status).json({ error: authorized.error })
      return
    }

    const body = (req.body ?? {}) as {
      tenantId?: string
      provider?: string
      credentials?: ProviderCredentials
    }
    const tenantId = body.tenantId?.trim()
    const provider = body.provider?.trim()
    const credentials = body.credentials

    if (!tenantId || !provider || !credentials) {
      res.status(400).json({ error: 'tenantId, provider, and credentials are required' })
      return
    }

    if (!isProviderCredentials(credentials)) {
      res.status(400).json({ error: 'Invalid credentials payload' })
      return
    }

    try {
      await this.credentialVault.set(tenantId, provider, credentials)
      res.json({ success: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: message })
    }
  }

  private handleCredentialDelete = async (req: Request, res: Response): Promise<void> => {
    const authorized = this.authorizeAdmin(req)
    if (!authorized.ok) {
      res.status(authorized.status).json({ error: authorized.error })
      return
    }

    const body = (req.body ?? {}) as { tenantId?: string; provider?: string }
    const tenantId = body.tenantId?.trim()
    const provider = body.provider?.trim()

    if (!tenantId || !provider) {
      res.status(400).json({ error: 'tenantId and provider are required' })
      return
    }

    try {
      await this.credentialVault.delete(tenantId, provider)
      res.json({ success: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: message })
    }
  }

  private authenticateRequest(req: Request): AuthResult {
    const apiKeyHeader = req.header('x-api-key')
    if (this.apiKey) {
      if (apiKeyHeader && safeCompare(apiKeyHeader, this.apiKey)) {
        return { ok: true, status: 200, authType: 'api_key' }
      }
    }

    const authorization = req.header('authorization')
    if (authorization?.toLowerCase().startsWith('bearer ')) {
      const token = authorization.slice(7).trim()
      if (this.jwtSecret) {
        const payload = verifyJwtHS256(token, this.jwtSecret)
        if (payload) {
          return {
            ok: true,
            status: 200,
            authType: 'jwt',
            tenantId: resolveTenantFromJwt(payload),
          }
        }
      }
      if (this.sessionToken && safeCompare(token, this.sessionToken)) {
        return { ok: true, status: 200, authType: 'session' }
      }
    }

    const sessionHeader = req.header('x-session-id')
    if (this.sessionToken && sessionHeader && safeCompare(sessionHeader, this.sessionToken)) {
      return { ok: true, status: 200, authType: 'session' }
    }

    if (!this.apiKey && !this.jwtSecret && !this.sessionToken) {
      if (!this.allowInsecure) {
        return { ok: false, status: 401, error: 'Proxy auth is not configured' }
      }
      if (!warnedAboutInsecureAuth) {
        warnedAboutInsecureAuth = true
        logProxyEvent('warn', 'insecure_auth_enabled', {})
      }
      return { ok: true, status: 200, authType: 'insecure' }
    }

    return { ok: false, status: 401, error: 'Unauthorized' }
  }

  private authorizeAdmin(req: Request): { ok: boolean; status: number; error?: string } {
    if (!this.adminApiKey) {
      return { ok: false, status: 403, error: 'Admin API key is not configured' }
    }

    const adminKeyHeader = req.header('x-proxy-admin-key')
    if (!adminKeyHeader || !safeCompare(adminKeyHeader, this.adminApiKey)) {
      return { ok: false, status: 403, error: 'Invalid admin key' }
    }

    return { ok: true, status: 200 }
  }
}

export const registerProxyRoutes = (app: Express, options?: ProxyGatewayOptions): void => {
  const gateway = new ProxyGateway(options)
  gateway.register(app)
}

function resolveTenantId(req: Request, body: ProxyRequestBody, auth: AuthResult): string | undefined {
  return (
    body.tenantId?.trim() ||
    req.header('x-tenant-id')?.trim() ||
    auth.tenantId?.trim() ||
    undefined
  )
}

function resolveToolName(req: Request, body: ProxyRequestBody): string | undefined {
  return (
    body.toolName?.trim() ||
    req.header('x-tool-name')?.trim() ||
    req.header('x-tool-id')?.trim() ||
    undefined
  )
}

function normalizeParams(raw: ProxyRequestBody['params']): JsonObject {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('params must be an object')
      }
      return parsed as JsonObject
    } catch (error) {
      throw new Error('params must be valid JSON')
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as JsonObject
  }
  throw new Error('params must be an object')
}

function extractPathParams(pathTemplate: string): string[] {
  const params = new Set<string>()
  const regex = /{([^}]+)}|:([A-Za-z0-9_]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(pathTemplate)) !== null) {
    const name = match[1] ?? match[2]
    if (name) params.add(name)
  }
  return [...params]
}

function fillPathParams(pathTemplate: string, params: JsonObject): string {
  const regex = /{([^}]+)}|:([A-Za-z0-9_]+)/g
  return pathTemplate.replace(regex, (_match, braced, colon) => {
    const key = braced ?? colon
    if (!key || params[key] === undefined) {
      throw new Error(`Missing path parameter: ${String(key)}`)
    }
    return encodeURIComponent(String(params[key]))
  })
}

async function buildProviderRequest(
  adapter: ProviderAdapter,
  actionSpec: ProviderActionSpec,
  context: AdapterContext,
  vault: CredentialVault
): Promise<{ url: string; method: HttpMethod; headers: Record<string, string>; body?: string }> {
  const resolvedPath = fillPathParams(actionSpec.path, context.params)
  const baseUrl = actionSpec.path.startsWith('http') ? '' : adapter.resolveBaseUrl(context)
  const url = new URL(resolvedPath, baseUrl)

  const queryParams = actionSpec.queryParams ?? []
  for (const key of queryParams) {
    if (context.params[key] === undefined) continue
    appendQueryParam(url.searchParams, key, context.params[key])
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(adapter.defaultHeaders ?? {}),
  }

  const authPlacement = await resolveAuthPlacement(context.credentials, actionSpec, vault, context)
  if (authPlacement.headerName) {
    headers[authPlacement.headerName] = authPlacement.value
  } else if (authPlacement.queryParam) {
    appendQueryParam(url.searchParams, authPlacement.queryParam, authPlacement.value)
  }

  const method = actionSpec.method
  let body: string | undefined
  if (method !== 'GET' && method !== 'DELETE') {
    const bodyKeys = getBodyKeys(actionSpec, queryParams, extractPathParams(actionSpec.path))
    const bodyPayload: JsonObject = {}
    for (const key of bodyKeys) {
      if (context.params[key] !== undefined) {
        bodyPayload[key] = context.params[key]
      }
    }
    if (Object.keys(bodyPayload).length > 0) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(bodyPayload)
    }
  }

  return { url: url.toString(), method, headers, body }
}

async function resolveAuthPlacement(
  credentials: ProviderCredentials,
  actionSpec: ProviderActionSpec,
  vault: CredentialVault,
  context: AdapterContext
): Promise<{ headerName?: string; queryParam?: string; value: string }> {
  if (credentials.type === 'api_key') {
    const headerName = credentials.headerName ?? 'x-api-key'
    if (credentials.queryParam) {
      return { queryParam: credentials.queryParam, value: credentials.apiKey }
    }
    return { headerName, value: credentials.apiKey }
  }

  if (credentials.type === 'bearer') {
    return { headerName: 'Authorization', value: `Bearer ${credentials.token}` }
  }

  const accessToken = await getAccessToken(credentials, actionSpec, vault, context)
  return { headerName: 'Authorization', value: `Bearer ${accessToken}` }
}

async function getAccessToken(
  credentials: ProviderCredentials,
  actionSpec: ProviderActionSpec,
  vault: CredentialVault,
  context: AdapterContext
): Promise<string> {
  if (credentials.type === 'oauth2') {
    if (credentials.accessToken && !isExpired(credentials.accessTokenExpiresAt)) {
      return credentials.accessToken
    }
    const refreshed = await refreshOAuthToken(credentials)
    try {
      await vault.set(context.tenantId, context.provider, refreshed)
    } catch (error) {
      logProxyEvent('warn', 'credential_cache_update_failed', {
        provider: context.provider,
        tenantId: context.tenantId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return refreshed.accessToken ?? ''
  }

  if (credentials.type === 'client_credentials') {
    if (credentials.accessToken && !isExpired(credentials.accessTokenExpiresAt)) {
      return credentials.accessToken
    }
    const refreshed = await requestClientCredentialsToken(credentials)
    try {
      await vault.set(context.tenantId, context.provider, refreshed)
    } catch (error) {
      logProxyEvent('warn', 'credential_cache_update_failed', {
        provider: context.provider,
        tenantId: context.tenantId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return refreshed.accessToken ?? ''
  }

  if (credentials.type === 'service_account') {
    if (credentials.accessToken && !isExpired(credentials.accessTokenExpiresAt)) {
      return credentials.accessToken
    }
    const refreshed = await requestServiceAccountToken(credentials, actionSpec)
    try {
      await vault.set(context.tenantId, context.provider, refreshed)
    } catch (error) {
      logProxyEvent('warn', 'credential_cache_update_failed', {
        provider: context.provider,
        tenantId: context.tenantId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return refreshed.accessToken ?? ''
  }

  throw new Error('Unsupported credential type for bearer auth')
}

function getBodyKeys(actionSpec: ProviderActionSpec, queryParams: string[], pathParams: string[]): string[] {
  if (actionSpec.bodyParams) {
    return actionSpec.bodyParams
  }
  if (!actionSpec.allowedParams) {
    return []
  }
  return actionSpec.allowedParams.filter(
    key => !queryParams.includes(key) && !pathParams.includes(key)
  )
}

function appendQueryParam(searchParams: URLSearchParams, key: string, value: any): void {
  if (Array.isArray(value)) {
    value.forEach(item => searchParams.append(key, String(item)))
    return
  }
  if (typeof value === 'object' && value !== null) {
    searchParams.append(key, JSON.stringify(value))
    return
  }
  searchParams.append(key, String(value))
}

function isExpired(expiresAt?: number): boolean {
  if (!expiresAt) return true
  return Date.now() >= expiresAt - DEFAULT_TOKEN_REFRESH_SKEW_MS
}

async function refreshOAuthToken(credentials: OAuth2Credentials): Promise<OAuth2Credentials> {
  const response = await fetch(credentials.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`)
  }

  const tokenData = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string }
  const expiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000
  return {
    ...credentials,
    accessToken: tokenData.access_token ?? credentials.accessToken,
    accessTokenExpiresAt: expiresAt,
    scopes: tokenData.scope ? tokenData.scope.split(' ') : credentials.scopes,
  }
}

async function requestClientCredentialsToken(credentials: ClientCredentials): Promise<ClientCredentials> {
  const response = await fetch(credentials.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: credentials.scopes?.join(' ') ?? '',
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Client credentials token failed: ${response.status} ${errorText}`)
  }

  const tokenData = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string }
  const expiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000
  return {
    ...credentials,
    accessToken: tokenData.access_token ?? credentials.accessToken,
    accessTokenExpiresAt: expiresAt,
    scopes: tokenData.scope ? tokenData.scope.split(' ') : credentials.scopes,
  }
}

async function requestServiceAccountToken(
  credentials: ServiceAccountCredentials,
  actionSpec: ProviderActionSpec
): Promise<ServiceAccountCredentials> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const scope = credentials.scopes?.join(' ') ?? actionSpec.requiredScopes?.join(' ') ?? ''
  if (!scope) {
    throw new Error('Service account token requires scopes')
  }

  const assertion = signServiceAccountJwt({
    issuer: credentials.clientEmail,
    scope,
    audience: credentials.tokenUrl,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 3600,
    privateKey: credentials.privateKey,
  })

  const response = await fetch(credentials.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Service account token failed: ${response.status} ${errorText}`)
  }

  const tokenData = (await response.json()) as { access_token?: string; expires_in?: number }
  const expiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000
  return {
    ...credentials,
    accessToken: tokenData.access_token ?? credentials.accessToken,
    accessTokenExpiresAt: expiresAt,
  }
}

function signServiceAccountJwt(options: {
  issuer: string
  scope: string
  audience: string
  issuedAt: number
  expiresAt: number
  privateKey: string
}): string {
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: options.issuer,
    scope: options.scope,
    aud: options.audience,
    iat: options.issuedAt,
    exp: options.expiresAt,
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const data = `${encodedHeader}.${encodedPayload}`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(data)
  signer.end()
  const signature = signer.sign(options.privateKey)
  return `${data}.${base64UrlEncode(signature)}`
}

async function forwardRequest(options: {
  url: string
  method: HttpMethod
  headers: Record<string, string>
  body?: string
  responseType?: 'json' | 'text'
}): Promise<{ ok: boolean; status: number; data: any; headers?: Record<string, string> }> {
  const response = await fetch(options.url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  })

  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers[key.toLowerCase()] = value
    }
  })

  let data: any = null
  const responseType = options.responseType ?? (headers['content-type']?.includes('application/json') ? 'json' : 'text')

  if (response.status !== 204) {
    if (responseType === 'json') {
      try {
        data = await response.json()
      } catch {
        data = await response.text()
      }
    } else {
      data = await response.text()
    }
  }

  return { ok: response.ok, status: response.status, data, headers }
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function hasSupabaseConfig(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function isRedisReady(client: { status?: string }): boolean {
  return client.status === 'ready'
}

function normalizeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}

function verifyJwtHS256(token: string, secret: string): Record<string, any> | null {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.')
    if (!headerB64 || !payloadB64 || !signatureB64) return null
    const headerJson = base64UrlDecode(headerB64)
    const header = JSON.parse(headerJson) as { alg?: string }
    if (header.alg !== 'HS256') return null

    const data = `${headerB64}.${payloadB64}`
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64')
    const expectedB64 = base64UrlNormalize(expected)
    if (!safeCompare(expectedB64, signatureB64)) return null

    const payloadJson = base64UrlDecode(payloadB64)
    const payload = JSON.parse(payloadJson) as Record<string, any>
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (typeof payload.exp === 'number' && payload.exp < nowSeconds) return null
    if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) return null
    return payload
  } catch {
    return null
  }
}

function resolveTenantFromJwt(payload: Record<string, any>): string | undefined {
  return payload.tenant_id || payload.tenant || payload.sub
}

function getCredentialScopes(credentials: ProviderCredentials): string[] | undefined {
  switch (credentials.type) {
    case 'oauth2':
    case 'client_credentials':
    case 'service_account':
      return credentials.scopes
    default:
      return undefined
  }
}

function base64UrlEncode(input: string | Buffer): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

function base64UrlNormalize(input: string): string {
  return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function readEnvInt(key: string): number | undefined {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

function isProviderCredentials(value: any): value is ProviderCredentials {
  if (!value || typeof value !== 'object') return false
  if (value.type === 'oauth2') {
    return Boolean(value.clientId && value.clientSecret && value.refreshToken && value.tokenUrl)
  }
  if (value.type === 'client_credentials') {
    return Boolean(value.clientId && value.clientSecret && value.tokenUrl)
  }
  if (value.type === 'api_key') {
    return Boolean(value.apiKey)
  }
  if (value.type === 'bearer') {
    return Boolean(value.token)
  }
  if (value.type === 'service_account') {
    return Boolean(value.clientEmail && value.privateKey && value.tokenUrl)
  }
  return false
}

function mapRecordToCredentials(record: ProviderCredentialRecord): ProviderCredentials | undefined {
  const refreshToken = record.refresh_token
  const clientId = record.client_id
  const clientSecret = record.client_secret
  const tokenUrl = record.token_url || defaultTokenUrl(record.provider)

  if (!refreshToken || !clientId || !clientSecret || !tokenUrl) {
    return undefined
  }

  return {
    type: 'oauth2',
    clientId,
    clientSecret,
    refreshToken,
    tokenUrl,
    scopes: record.scopes ?? undefined,
  }
}

function normalizeCredentialPayload(provider: string, payload: any): ProviderCredentials | undefined {
  if (!payload || typeof payload !== 'object') return undefined

  if (payload.type) {
    const type = payload.type
    if (type === 'oauth2') {
      const clientId = payload.clientId || payload.client_id
      const clientSecret = payload.clientSecret || payload.client_secret
      const refreshToken = payload.refreshToken || payload.refresh_token
      const tokenUrl = payload.tokenUrl || payload.token_uri || defaultTokenUrl(provider)
      if (!clientId || !clientSecret || !refreshToken || !tokenUrl) return undefined
      return {
        type: 'oauth2',
        clientId,
        clientSecret,
        refreshToken,
        tokenUrl,
        scopes: payload.scopes,
        accessToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
      }
    }
    if (type === 'client_credentials') {
      const clientId = payload.clientId || payload.client_id
      const clientSecret = payload.clientSecret || payload.client_secret
      const tokenUrl = payload.tokenUrl || payload.token_uri || defaultTokenUrl(provider)
      if (!clientId || !clientSecret || !tokenUrl) return undefined
      return {
        type: 'client_credentials',
        clientId,
        clientSecret,
        tokenUrl,
        scopes: payload.scopes,
        accessToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
      }
    }
    if (type === 'api_key') {
      const apiKey = payload.apiKey || payload.api_key
      if (!apiKey) return undefined
      return {
        type: 'api_key',
        apiKey,
        headerName: payload.headerName || payload.header_name,
        queryParam: payload.queryParam || payload.query_param,
        ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}),
        ...(payload.shopDomain ? { shopDomain: payload.shopDomain } : {}),
      } as ApiKeyCredentials
    }
    if (type === 'bearer') {
      const token = payload.token || payload.access_token
      if (!token) return undefined
      return {
        type: 'bearer',
        token,
        expiresAt: payload.expiresAt || payload.expires_at,
      }
    }
    if (type === 'service_account') {
      const clientEmail = payload.clientEmail || payload.client_email
      const privateKey = payload.privateKey || payload.private_key
      const tokenUrl = payload.tokenUrl || payload.token_uri || defaultTokenUrl(provider)
      if (!clientEmail || !privateKey || !tokenUrl) return undefined
      return {
        type: 'service_account',
        clientEmail,
        privateKey,
        tokenUrl,
        scopes: payload.scopes,
        accessToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
      }
    }
  }

  if (payload.installed || payload.web) {
    const source = payload.installed || payload.web
    const refreshToken = payload.refresh_token || payload.refreshToken || source.refresh_token || source.refreshToken
    if (!refreshToken) return undefined
    return {
      type: 'oauth2',
      clientId: source.client_id,
      clientSecret: source.client_secret,
      refreshToken,
      tokenUrl: source.token_uri || defaultTokenUrl(provider),
      scopes: payload.scopes,
    }
  }

  if (payload.client_email || payload.private_key) {
    const clientEmail = payload.client_email || payload.clientEmail
    const privateKey = payload.private_key || payload.privateKey
    const tokenUrl = payload.token_uri || payload.tokenUrl || defaultTokenUrl(provider)
    if (!clientEmail || !privateKey || !tokenUrl) return undefined
    return {
      type: 'service_account',
      clientEmail,
      privateKey,
      tokenUrl,
      scopes: payload.scopes,
    }
  }

  return undefined
}

function defaultTokenUrl(provider: string): string {
  if (provider.startsWith('google')) return DEFAULT_GOOGLE_TOKEN_URL
  return DEFAULT_GOOGLE_TOKEN_URL
}

function logProxyEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  details: Record<string, any>
): void {
  const payload = {
    event,
    ...details,
  }
  if (level === 'info') {
    console.log(PROXY_LOG_PREFIX, payload)
  } else if (level === 'warn') {
    console.warn(PROXY_LOG_PREFIX, payload)
  } else {
    console.error(PROXY_LOG_PREFIX, payload)
  }
}

function createDefaultAdapters(): Record<string, ProviderAdapter> {
  const googleDrive: ProviderAdapter = {
    name: 'google_drive',
    resolveBaseUrl: () => 'https://www.googleapis.com/drive/v3/',
    actions: {
      list: {
        method: 'GET',
        path: 'files',
        allowedParams: [
          'pageSize',
          'pageToken',
          'q',
          'fields',
          'orderBy',
          'corpora',
          'driveId',
          'includeItemsFromAllDrives',
          'supportsAllDrives',
        ],
        queryParams: [
          'pageSize',
          'pageToken',
          'q',
          'fields',
          'orderBy',
          'corpora',
          'driveId',
          'includeItemsFromAllDrives',
          'supportsAllDrives',
        ],
      },
      get: {
        method: 'GET',
        path: 'files/{fileId}',
        allowedParams: ['fileId', 'fields', 'supportsAllDrives', 'acknowledgeAbuse', 'alt'],
        queryParams: ['fields', 'supportsAllDrives', 'acknowledgeAbuse', 'alt'],
      },
    },
  }

  const gmail: ProviderAdapter = {
    name: 'gmail',
    resolveBaseUrl: () => 'https://gmail.googleapis.com/gmail/v1/',
    actions: {
      list_messages: {
        method: 'GET',
        path: 'users/me/messages',
        allowedParams: ['q', 'maxResults', 'pageToken', 'includeSpamTrash', 'labelIds'],
        queryParams: ['q', 'maxResults', 'pageToken', 'includeSpamTrash', 'labelIds'],
      },
      get_message: {
        method: 'GET',
        path: 'users/me/messages/{id}',
        allowedParams: ['id', 'format', 'metadataHeaders'],
        queryParams: ['format', 'metadataHeaders'],
      },
    },
  }

  const shopify: ProviderAdapter = {
    name: 'shopify',
    resolveBaseUrl: context => {
      const credentials = context.credentials
      if (credentials.type === 'api_key' && typeof (credentials as ApiKeyCredentials).queryParam === 'string') {
        throw new Error('Shopify credentials must use headerName for access token')
      }
      const baseUrl =
        (credentials as { baseUrl?: string }).baseUrl ||
        (credentials as { shopDomain?: string }).shopDomain
      if (!baseUrl || typeof baseUrl !== 'string') {
        throw new Error('Shopify credentials require baseUrl or shopDomain')
      }
      const normalized = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`
      return normalized.endsWith('/') ? normalized : `${normalized}/`
    },
    actions: {
      graphql: {
        method: 'POST',
        path: 'admin/api/{apiVersion}/graphql.json',
        allowedParams: ['query', 'variables', 'apiVersion'],
        bodyParams: ['query', 'variables'],
      },
    },
  }

  return {
    google_drive: googleDrive,
    gmail,
    shopify,
  }
}
