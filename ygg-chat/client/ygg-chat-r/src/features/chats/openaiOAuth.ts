// OpenAI ChatGPT OAuth Authentication Module
// Uses OpenAI's official OAuth flow (same as Codex CLI)
// For personal use with ChatGPT Plus/Pro subscriptions

// OAuth Configuration (from OpenAI Codex CLI)
export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const OPENAI_SCOPE = 'openid profile email offline_access'

// ChatGPT Backend API
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api'
export const CHATGPT_CODEX_ENDPOINT = '/codex/responses'
export const CHATGPT_USAGE_ENDPOINT = '/wham/usage'

// JWT claim path for ChatGPT account ID
export const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

const CODEX_GITHUB_API_RELEASES = 'https://api.github.com/repos/openai/codex/releases/latest'
const CODEX_GITHUB_HTML_RELEASES = 'https://github.com/openai/codex/releases/latest'
const CODEX_CACHE_TTL_MS = 15 * 60 * 1000

type CodexModelFamily =
  | 'gpt-5.4'
  | 'gpt-5.3-codex'
  | 'gpt-5.2-codex'
  | 'gpt-5.1-codex-mini'
  | 'codex-max'
  | 'codex'
  | 'gpt-5.2'
  | 'gpt-5.1'

const CODEX_PROMPT_FILES: Record<CodexModelFamily, string> = {
  // GPT-5.4 currently reuses the GPT-5.2 general prompt in codex-rs/core.
  'gpt-5.4': 'gpt_5_2_prompt.md',
  // GPT-5.3 Codex currently shares the GPT-5.2 Codex instruction prompt in codex-rs/core.
  'gpt-5.3-codex': 'gpt-5.2-codex_prompt.md',
  'gpt-5.2-codex': 'gpt-5.2-codex_prompt.md',
  'gpt-5.1-codex-mini': 'gpt_5_codex_prompt.md',
  'codex-max': 'gpt-5.1-codex-max_prompt.md',
  codex: 'gpt_5_codex_prompt.md',
  'gpt-5.2': 'gpt_5_2_prompt.md',
  'gpt-5.1': 'gpt_5_1_prompt.md',
}

const CODEX_CACHE_KEYS: Record<CodexModelFamily, string> = {
  'gpt-5.4': 'openai_codex_instructions_gpt-5.4',
  'gpt-5.3-codex': 'openai_codex_instructions_gpt-5.3-codex',
  'gpt-5.2-codex': 'openai_codex_instructions_gpt-5.2-codex',
  'gpt-5.1-codex-mini': 'openai_codex_instructions_gpt-5.1-codex-mini',
  'codex-max': 'openai_codex_instructions_codex-max',
  codex: 'openai_codex_instructions_codex',
  'gpt-5.2': 'openai_codex_instructions_gpt-5.2',
  'gpt-5.1': 'openai_codex_instructions_gpt-5.1',
}

const CODEX_CACHE_META_KEYS: Record<CodexModelFamily, string> = {
  'gpt-5.4': 'openai_codex_instructions_gpt-5.4_meta',
  'gpt-5.3-codex': 'openai_codex_instructions_gpt-5.3-codex_meta',
  'gpt-5.2-codex': 'openai_codex_instructions_gpt-5.2-codex_meta',
  'gpt-5.1-codex-mini': 'openai_codex_instructions_gpt-5.1-codex-mini_meta',
  'codex-max': 'openai_codex_instructions_codex-max_meta',
  codex: 'openai_codex_instructions_codex_meta',
  'gpt-5.2': 'openai_codex_instructions_gpt-5.2_meta',
  'gpt-5.1': 'openai_codex_instructions_gpt-5.1_meta',
}

interface CodexInstructionsMeta {
  etag?: string
  tag?: string
  lastChecked?: number
  url?: string
}

export interface OpenAITokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

export interface OpenAIUsageWindow {
  usedPercent: number | null
  resetAtIso: string | null
  limitWindowSeconds: number | null
}

export interface OpenAIUsageSnapshot {
  planType: string | null
  session: OpenAIUsageWindow
  weekly: OpenAIUsageWindow
  reviews: OpenAIUsageWindow
  credits: {
    hasCredits: boolean
    unlimited: boolean
    balance: number | null
  } | null
  fetchedAtIso: string
}

export type OpenAIUsageResult =
  | { type: 'success'; data: OpenAIUsageSnapshot }
  | { type: 'unauthenticated'; error: string }
  | { type: 'error'; error: string }

export interface PKCEPair {
  verifier: string
  challenge: string
}

export interface AuthorizationFlow {
  pkce: PKCEPair
  state: string
  url: string
}

export interface TokenResult {
  type: 'success' | 'failed'
  access?: string
  refresh?: string
  expires?: number
}

export interface JWTPayload {
  [key: string]: any
}

function getCodexModelFamily(model: string): CodexModelFamily {
  const normalized = (model || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
  if (normalized.includes('gpt-5.4') || normalized.includes('gpt 5.4')) {
    return 'gpt-5.4'
  }
  if (normalized.includes('gpt-5.3-codex')) {
    return 'gpt-5.3-codex'
  }
  if (normalized.includes('gpt-5.2-codex') || normalized.includes('gpt 5.2 codex')) {
    return 'gpt-5.2-codex'
  }
  if (normalized.includes('gpt-5.1-codex-mini') || normalized.includes('gpt 5.1 codex mini')) {
    return 'gpt-5.1-codex-mini'
  }
  if (normalized.includes('codex-max') || normalized.includes('codex max')) {
    return 'codex-max'
  }
  if (normalized.includes('codex') || normalized.startsWith('codex-')) {
    return 'codex'
  }
  if (normalized.includes('gpt-5.2') || normalized.includes('gpt 5.2')) {
    return 'gpt-5.2'
  }
  return 'gpt-5.1'
}

async function getLatestCodexReleaseTag(): Promise<string> {
  try {
    const response = await fetch(CODEX_GITHUB_API_RELEASES)
    if (response.ok) {
      const data = (await response.json()) as { tag_name?: string }
      if (data?.tag_name) {
        return data.tag_name
      }
    }
  } catch {
    // Fall through to HTML parsing
  }

  const htmlResponse = await fetch(CODEX_GITHUB_HTML_RELEASES)
  if (!htmlResponse.ok) {
    throw new Error(`Failed to fetch latest release: ${htmlResponse.status}`)
  }

  const finalUrl = htmlResponse.url
  if (finalUrl) {
    const parts = finalUrl.split('/tag/')
    const last = parts[parts.length - 1]
    if (last && !last.includes('/')) {
      return last
    }
  }

  const html = await htmlResponse.text()
  const match = html.match(/\/openai\/codex\/releases\/tag\/([^"]+)/)
  if (match && match[1]) {
    return match[1]
  }

  throw new Error('Failed to determine latest release tag from GitHub')
}

export async function getCodexInstructions(model: string): Promise<string> {
  const family = getCodexModelFamily(model)
  const promptFile = CODEX_PROMPT_FILES[family]
  const cacheKey = CODEX_CACHE_KEYS[family]
  const metaKey = CODEX_CACHE_META_KEYS[family]

  let cachedMeta: CodexInstructionsMeta | null = null
  try {
    const rawMeta = localStorage.getItem(metaKey)
    cachedMeta = rawMeta ? (JSON.parse(rawMeta) as CodexInstructionsMeta) : null
  } catch {
    cachedMeta = null
  }

  const cachedInstructions = localStorage.getItem(cacheKey)
  if (cachedInstructions && cachedMeta?.lastChecked && Date.now() - cachedMeta.lastChecked < CODEX_CACHE_TTL_MS) {
    return cachedInstructions
  }

  let cachedETag = cachedMeta?.etag || null
  const cachedTag = cachedMeta?.tag || null
  const latestTag = await getLatestCodexReleaseTag()
  const instructionsUrl = `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/core/${promptFile}`

  if (cachedTag !== latestTag) {
    cachedETag = null
  }

  const headers: Record<string, string> = {}
  if (cachedETag) {
    headers['If-None-Match'] = cachedETag
  }

  try {
    const response = await fetch(instructionsUrl, { headers })

    if (response.status === 304 && cachedInstructions) {
      localStorage.setItem(
        metaKey,
        JSON.stringify({
          etag: cachedETag || undefined,
          tag: latestTag,
          lastChecked: Date.now(),
          url: instructionsUrl,
        } satisfies CodexInstructionsMeta)
      )
      return cachedInstructions
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const instructions = await response.text()
    const newETag = response.headers.get('etag') || undefined
    localStorage.setItem(cacheKey, instructions)
    localStorage.setItem(
      metaKey,
      JSON.stringify({
        etag: newETag,
        tag: latestTag,
        lastChecked: Date.now(),
        url: instructionsUrl,
      } satisfies CodexInstructionsMeta)
    )
    return instructions
  } catch (error) {
    if (cachedInstructions) {
      return cachedInstructions
    }
    throw new Error(`Failed to load Codex instructions: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Generate random bytes as hex string
function randomHex(length: number): string {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Base64URL encode (no padding)
function base64URLEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Generate PKCE verifier and challenge
export async function generatePKCE(): Promise<PKCEPair> {
  // Generate random verifier (43-128 characters)
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64URLEncode(verifierBytes.buffer)

  // Generate S256 challenge
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const challenge = base64URLEncode(hash)

  return { verifier, challenge }
}

// Generate random state for OAuth flow
export function createState(): string {
  return randomHex(16)
}

// Create OAuth authorization URL
export async function createAuthorizationFlow(): Promise<AuthorizationFlow> {
  const pkce = await generatePKCE()
  const state = createState()

  const url = new URL(OPENAI_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OPENAI_CLIENT_ID)
  url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI)
  url.searchParams.set('scope', OPENAI_SCOPE)
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'codex_cli_rs')

  return { pkce, state, url: url.toString() }
}

// Exchange authorization code for tokens
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = OPENAI_REDIRECT_URI
): Promise<TokenResult> {
  try {
    const res = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OPENAI_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[OpenAI OAuth] Code exchange failed:', res.status, text)
      return { type: 'failed' }
    }

    const json = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }

    if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== 'number') {
      console.error('[OpenAI OAuth] Token response missing fields:', json)
      return { type: 'failed' }
    }

    return {
      type: 'success',
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    }
  } catch (error) {
    console.error('[OpenAI OAuth] Exchange error:', error)
    return { type: 'failed' }
  }
}

// Refresh access token using refresh token
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  try {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      console.error('[OpenAI OAuth] Token refresh failed:', response.status, text)
      return { type: 'failed' }
    }

    const json = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }

    if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== 'number') {
      console.error('[OpenAI OAuth] Refresh response missing fields:', json)
      return { type: 'failed' }
    }

    return {
      type: 'success',
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    }
  } catch (error) {
    console.error('[OpenAI OAuth] Refresh error:', error)
    return { type: 'failed' }
  }
}

// Decode JWT to extract payload
export function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    // Handle base64url decoding
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const decoded = atob(padded)
    return JSON.parse(decoded) as JWTPayload
  } catch {
    return null
  }
}

// Extract ChatGPT account ID from JWT
export function extractAccountId(accessToken: string): string | null {
  const decoded = decodeJWT(accessToken)
  if (!decoded) return null
  const authClaim = decoded[JWT_CLAIM_PATH]
  return authClaim?.chatgpt_account_id || null
}

// Check if token needs refresh (5 minute buffer)
export function shouldRefreshToken(expiresAt: number): boolean {
  const buffer = 5 * 60 * 1000 // 5 minutes
  return Date.now() >= expiresAt - buffer
}

// Storage key for tokens
const OPENAI_TOKENS_KEY = 'openai_chatgpt_tokens'

// Save tokens to localStorage and mirror to Electron storage when available
export function saveTokens(tokens: OpenAITokens): void {
  localStorage.setItem(OPENAI_TOKENS_KEY, JSON.stringify(tokens))

  if (typeof window !== 'undefined' && window.electronAPI?.storage?.set) {
    void window.electronAPI.storage.set(OPENAI_TOKENS_KEY, tokens).catch(error => {
      console.error('Failed to mirror OpenAI tokens to Electron storage:', error)
    })
  }
}

// Load tokens from localStorage, falling back to Electron storage when available
export function loadTokens(): OpenAITokens | null {
  try {
    const stored = localStorage.getItem(OPENAI_TOKENS_KEY)
    if (stored) {
      return JSON.parse(stored) as OpenAITokens
    }
  } catch {
    return null
  }

  return null
}

export async function loadTokensFromElectronStorage(): Promise<OpenAITokens | null> {
  if (typeof window === 'undefined' || !window.electronAPI?.storage?.get) {
    return null
  }

  try {
    const stored = await window.electronAPI.storage.get(OPENAI_TOKENS_KEY)
    if (!stored || typeof stored !== 'object') return null

    const tokens = stored as OpenAITokens
    if (!tokens.accessToken || !tokens.refreshToken || !tokens.accountId || !tokens.expiresAt) {
      return null
    }

    localStorage.setItem(OPENAI_TOKENS_KEY, JSON.stringify(tokens))
    return tokens
  } catch {
    return null
  }
}

// Clear tokens from localStorage and Electron storage when available
export function clearTokens(): void {
  localStorage.removeItem(OPENAI_TOKENS_KEY)

  if (typeof window !== 'undefined' && window.electronAPI?.storage?.set) {
    void window.electronAPI.storage.set(OPENAI_TOKENS_KEY, null).catch(error => {
      console.error('Failed to clear mirrored OpenAI tokens from Electron storage:', error)
    })
  }
}

// Get valid tokens (refresh if needed)
export async function getValidTokens(): Promise<OpenAITokens | null> {
  const tokens = loadTokens() || (await loadTokensFromElectronStorage())
  if (!tokens) return null

  if (shouldRefreshToken(tokens.expiresAt)) {
    const result = await refreshAccessToken(tokens.refreshToken)
    if (result.type === 'failed') {
      clearTokens()
      return null
    }

    const accountId = extractAccountId(result.access!)
    if (!accountId) {
      clearTokens()
      return null
    }

    const newTokens: OpenAITokens = {
      accessToken: result.access!,
      refreshToken: result.refresh!,
      expiresAt: result.expires!,
      accountId,
    }
    saveTokens(newTokens)
    return newTokens
  }

  return tokens
}

function parseUsageNumber(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toIsoFromUnixSeconds(value: unknown): string | null {
  const unixSeconds = parseUsageNumber(value)
  if (unixSeconds == null) return null

  try {
    return new Date(unixSeconds * 1000).toISOString()
  } catch {
    return null
  }
}

function parseUsageWindow(windowData: any, headerPercent: string | null): OpenAIUsageWindow {
  const usedPercent = parseUsageNumber(windowData?.used_percent) ?? parseUsageNumber(headerPercent)
  const resetAtIso = toIsoFromUnixSeconds(windowData?.reset_at)
  const limitWindowSeconds = parseUsageNumber(windowData?.limit_window_seconds)

  return {
    usedPercent,
    resetAtIso,
    limitWindowSeconds,
  }
}

export async function fetchOpenAIUsageStatus(): Promise<OpenAIUsageResult> {
  const tokens = await getValidTokens()
  if (!tokens) {
    return {
      type: 'unauthenticated',
      error: 'OpenAI authentication required. Sign in with your ChatGPT account first.',
    }
  }

  const url = `${CHATGPT_BASE_URL}${CHATGPT_USAGE_ENDPOINT}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: 'application/json',
        'ChatGPT-Account-Id': tokens.accountId,
      },
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      return {
        type: 'error',
        error: errorText?.trim()
          ? `OpenAI usage request failed (${response.status}): ${errorText.trim()}`
          : `OpenAI usage request failed (${response.status}).`,
      }
    }

    const payload = (await response.json()) as any

    const primaryPercentHeader = response.headers.get('x-codex-primary-used-percent')
    const secondaryPercentHeader = response.headers.get('x-codex-secondary-used-percent')

    const snapshot: OpenAIUsageSnapshot = {
      planType: typeof payload?.plan_type === 'string' ? payload.plan_type : null,
      session: parseUsageWindow(payload?.rate_limit?.primary_window, primaryPercentHeader),
      weekly: parseUsageWindow(payload?.rate_limit?.secondary_window, secondaryPercentHeader),
      reviews: parseUsageWindow(payload?.code_review_rate_limit?.primary_window, null),
      credits: payload?.credits
        ? {
            hasCredits: Boolean(payload.credits.has_credits),
            unlimited: Boolean(payload.credits.unlimited),
            balance: parseUsageNumber(payload.credits.balance),
          }
        : null,
      fetchedAtIso: new Date().toISOString(),
    }

    return { type: 'success', data: snapshot }
  } catch (error) {
    return {
      type: 'error',
      error: `Failed to fetch OpenAI usage: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// Check if user is authenticated with OpenAI
export function isOpenAIAuthenticated(): boolean {
  const tokens = loadTokens()
  return tokens !== null && tokens.accessToken !== ''
}

export async function isOpenAIAuthenticatedAsync(): Promise<boolean> {
  const tokens = loadTokens() || (await loadTokensFromElectronStorage())
  return tokens !== null && tokens.accessToken !== ''
}

// Parse authorization callback input (URL or code)
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = (input || '').trim()
  if (!value) return {}

  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // Not a URL, try other formats
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }

  return { code: value }
}

// Available ChatGPT models (based on Plus/Pro subscription)
export const CHATGPT_MODELS = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    displayName: 'GPT-5.4',
    description: 'Latest GPT-5.4 frontier model for professional work',
    contextLength: 400000,
    maxCompletionTokens: 128000,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    displayName: 'GPT-5.4 Mini',
    description: 'Strong mini model for coding, computer use, and subagents',
    contextLength: 400000,
    maxCompletionTokens: 128000,
  },
  {
    id: 'gpt-5.4-pro',
    name: 'GPT-5.4 Pro',
    displayName: 'GPT-5.4 Pro',
    description: 'Version of GPT-5.4 that produces smarter and more precise responses',
    contextLength: 400000,
    maxCompletionTokens: 128000,
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    displayName: 'GPT-5.3 Codex',
    description: 'Latest GPT-5.3 Codex model for coding tasks',
    contextLength: 400000,
    maxCompletionTokens: 16384,
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    displayName: 'GPT-5.2 Codex',
    description: 'Latest GPT-5.2 Codex model for coding tasks',
    contextLength: 400000,
    maxCompletionTokens: 16384,
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    displayName: 'GPT-5.2',
    description: 'GPT-5.2 general model',
    contextLength: 400000,
    maxCompletionTokens: 16384,
  },
  {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Codex Max',
    displayName: 'GPT-5.1 Codex Max',
    description: 'GPT-5.1 Codex Max for complex coding',
    contextLength: 200000,
    maxCompletionTokens: 16384,
  },
  {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex Mini',
    displayName: 'GPT-5.1 Codex Mini',
    description: 'GPT-5.1 Codex Mini for faster coding tasks',
    contextLength: 200000,
    maxCompletionTokens: 16384,
  },
  {
    id: 'gpt-5.1-codex',
    name: 'GPT-5.1 Codex',
    displayName: 'GPT-5.1 Codex',
    description: 'GPT-5.1 Codex for coding tasks',
    contextLength: 200000,
    maxCompletionTokens: 16384,
  },
  {
    id: 'gpt-5.1',
    name: 'GPT-5.1',
    displayName: 'GPT-5.1',
    description: 'GPT-5.1 general model',
    contextLength: 200000,
    maxCompletionTokens: 16384,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    displayName: 'GPT-4o',
    description: 'GPT-4o multimodal model',
    contextLength: 128000,
    maxCompletionTokens: 16384,
  },
]

// Get models list formatted for the app
export function getOpenAIChatGPTModels() {
  return CHATGPT_MODELS.map(m => ({
    id: m.id,
    name: m.name,
    displayName: m.displayName,
    version: 'chatgpt',
    description: m.description,
    contextLength: m.contextLength,
    maxCompletionTokens: m.maxCompletionTokens,
    inputTokenLimit: m.contextLength,
    outputTokenLimit: m.maxCompletionTokens,
    promptCost: 0,
    completionCost: 0,
    requestCost: 0,
    thinking: true,
    supportsImages: true,
    supportsWebSearch: false,
    supportsStructuredOutputs: true,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    defaultTemperature: null,
    defaultTopP: null,
    defaultFrequencyPenalty: null,
    topProviderContextLength: null,
    isFreeTier: false,
  }))
}
