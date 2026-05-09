// Electron-side OpenAI ChatGPT OAuth/token helpers.
// Renderer should not access raw OAuth tokens; use IPC wrappers exposed from main/preload.

export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback'
export const OPENAI_SCOPE = 'openid profile email offline_access'

export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api'
export const CHATGPT_CODEX_ENDPOINT = '/codex/responses'
export const CHATGPT_USAGE_ENDPOINT = '/wham/usage'
export const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
export const OPENAI_TOKENS_KEY = 'openai_chatgpt_tokens'

export interface OpenAITokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
}

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
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null
  fetchedAtIso: string
}

export type OpenAIUsageResult =
  | { type: 'success'; data: OpenAIUsageSnapshot }
  | { type: 'unauthenticated'; error: string }
  | { type: 'error'; error: string }

export type TokenStorage = {
  get: (key: string) => any
  set: (key: string, value: any) => boolean | void
  delete?: (key: string) => boolean | void
}

function randomHex(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64URLEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generatePKCE(): Promise<PKCEPair> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64URLEncode(verifierBytes.buffer)
  const data = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return { verifier, challenge: base64URLEncode(hash) }
}

export function createState(): string {
  return randomHex(16)
}

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

export async function exchangeAuthorizationCode(code: string, verifier: string, redirectUri: string = OPENAI_REDIRECT_URI): Promise<TokenResult> {
  try {
    const res = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OPENAI_CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirectUri }),
    })
    if (!res.ok) return { type: 'failed' }
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') return { type: 'failed' }
    return { type: 'success', access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 }
  } catch {
    return { type: 'failed' }
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  try {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OPENAI_CLIENT_ID }),
    })
    if (!response.ok) return { type: 'failed' }
    const json = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') return { type: 'failed' }
    return { type: 'success', access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 }
  } catch {
    return { type: 'failed' }
  }
}

export function decodeJWT(token: string): any | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

export function extractAccountId(accessToken: string): string | null {
  return decodeJWT(accessToken)?.[JWT_CLAIM_PATH]?.chatgpt_account_id || null
}

export function shouldRefreshToken(expiresAt: number): boolean {
  return Date.now() >= expiresAt - 5 * 60 * 1000
}

export function loadTokens(storage: TokenStorage): OpenAITokens | null {
  const stored = storage.get(OPENAI_TOKENS_KEY)
  if (!stored || typeof stored !== 'object') return null
  const tokens = stored as OpenAITokens
  if (!tokens.accessToken || !tokens.refreshToken || !tokens.accountId || !tokens.expiresAt) return null
  return tokens
}

export function saveTokens(storage: TokenStorage, tokens: OpenAITokens): void {
  storage.set(OPENAI_TOKENS_KEY, tokens)
}

export function clearTokens(storage: TokenStorage): void {
  if (storage.delete) storage.delete(OPENAI_TOKENS_KEY)
  else storage.set(OPENAI_TOKENS_KEY, null)
}

export async function getValidTokens(storage: TokenStorage): Promise<OpenAITokens | null> {
  const tokens = loadTokens(storage)
  if (!tokens) return null
  if (!shouldRefreshToken(tokens.expiresAt)) return tokens
  const result = await refreshAccessToken(tokens.refreshToken)
  if (result.type === 'failed') {
    clearTokens(storage)
    return null
  }
  const accountId = extractAccountId(result.access!)
  if (!accountId) {
    clearTokens(storage)
    return null
  }
  const refreshed: OpenAITokens = { accessToken: result.access!, refreshToken: result.refresh!, expiresAt: result.expires!, accountId }
  saveTokens(storage, refreshed)
  return refreshed
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
  return new Date(unixSeconds * 1000).toISOString()
}

function parseUsageWindow(windowData: any, headerPercent: string | null): OpenAIUsageWindow {
  return {
    usedPercent: parseUsageNumber(windowData?.used_percent) ?? parseUsageNumber(headerPercent),
    resetAtIso: toIsoFromUnixSeconds(windowData?.reset_at),
    limitWindowSeconds: parseUsageNumber(windowData?.limit_window_seconds),
  }
}

export async function fetchOpenAIUsageStatus(storage: TokenStorage): Promise<OpenAIUsageResult> {
  const tokens = await getValidTokens(storage)
  if (!tokens) return { type: 'unauthenticated', error: 'OpenAI authentication required. Sign in with your ChatGPT account first.' }
  try {
    const response = await fetch(`${CHATGPT_BASE_URL}${CHATGPT_USAGE_ENDPOINT}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json', 'ChatGPT-Account-Id': tokens.accountId },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { type: 'error', error: text?.trim() ? `OpenAI usage request failed (${response.status}): ${text.trim()}` : `OpenAI usage request failed (${response.status}).` }
    }
    const payload = (await response.json()) as any
    const data: OpenAIUsageSnapshot = {
      planType: typeof payload?.plan_type === 'string' ? payload.plan_type : null,
      session: parseUsageWindow(payload?.rate_limit?.primary_window, response.headers.get('x-codex-primary-used-percent')),
      weekly: parseUsageWindow(payload?.rate_limit?.secondary_window, response.headers.get('x-codex-secondary-used-percent')),
      reviews: parseUsageWindow(payload?.code_review_rate_limit?.primary_window, null),
      credits: payload?.credits ? { hasCredits: Boolean(payload.credits.has_credits), unlimited: Boolean(payload.credits.unlimited), balance: parseUsageNumber(payload.credits.balance) } : null,
      fetchedAtIso: new Date().toISOString(),
    }
    return { type: 'success', data }
  } catch (error) {
    return { type: 'error', error: `Failed to fetch OpenAI usage: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = (input || '').trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return { code: url.searchParams.get('code') ?? undefined, state: url.searchParams.get('state') ?? undefined }
  } catch {}
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined }
  }
  return { code: value }
}
