import Conf from 'conf'
import type { ProviderTokenStore } from './tokenStore.js'

export type StoredElectronAuthSession = {
  userId?: string | null
  accessToken?: string | null
  user?: { id?: string | null } | null
  session?: {
    access_token?: string | null
    refresh_token?: string | null
    expires_at?: number | string | null
    user?: { id?: string | null } | null
  } | null
}

export type StoredElectronOpenAiTokens = {
  accessToken?: string | null
  refreshToken?: string | null
  expiresAt?: number | string | null
  accountId?: string | null
}

const OPENAI_TOKENS_STORAGE_KEY = 'openai_chatgpt_tokens'
const OPENAI_SYNC_USER_ID = 'electron-openai-chatgpt'
const OPENAI_AUTH_CLAIM_PATH = 'https://api.openai.com/auth'

export function normalizeAuthorizationToken(token: string | null | undefined): string {
  return String(token || '').replace(/^Bearer\s+/i, '').trim()
}

function decodeJwtPayload(token: string): any | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const payload = parts[1]
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function extractOpenAiAccountId(accessToken: string | null | undefined): string | null {
  const normalizedToken = normalizeAuthorizationToken(accessToken)
  if (!normalizedToken) return null

  const decoded = decodeJwtPayload(normalizedToken)
  if (!decoded) return null
  const authClaim = decoded[OPENAI_AUTH_CLAIM_PATH]
  return typeof authClaim?.chatgpt_account_id === 'string' && authClaim.chatgpt_account_id.trim()
    ? authClaim.chatgpt_account_id.trim()
    : null
}

function normalizeExpiresAt(value: number | string | null | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return new Date(numeric).toISOString()
    }

    return trimmed
  }

  return null
}

export function readElectronAppAuthSession(): { userId: string | null; accessToken: string | null; refreshToken: string | null; expiresAt: string | null } {
  try {
    const store = new Conf({
      projectName: 'ygg-chat-r',
      configFileMode: 0o600,
    })

    const authSession = (store.get('auth_session') ?? null) as StoredElectronAuthSession | null
    const userId = String(authSession?.userId || authSession?.user?.id || authSession?.session?.user?.id || '').trim() || null
    const accessToken = normalizeAuthorizationToken(authSession?.accessToken || authSession?.session?.access_token)
    const refreshToken =
      typeof authSession?.session?.refresh_token === 'string' && authSession.session.refresh_token.trim()
        ? authSession.session.refresh_token.trim()
        : null
    const expiresAt = normalizeExpiresAt(authSession?.session?.expires_at ?? decodeJwtPayload(accessToken)?.exp * 1000)

    if (!userId || !accessToken || accessToken === 'electron-local-token') {
      return { userId: null, accessToken: null, refreshToken: null, expiresAt: null }
    }

    return { userId, accessToken, refreshToken, expiresAt }
  } catch {
    return { userId: null, accessToken: null, refreshToken: null, expiresAt: null }
  }
}

export function readElectronOpenAiChatGptTokens(): {
  userId: string
  accessToken: string | null
  refreshToken: string | null
  expiresAt: string | null
  accountId: string | null
} {
  try {
    const store = new Conf({
      projectName: 'ygg-chat-r',
      configFileMode: 0o600,
    })

    const rawTokens = (store.get(OPENAI_TOKENS_STORAGE_KEY) ?? null) as StoredElectronOpenAiTokens | null
    const accessToken = normalizeAuthorizationToken(rawTokens?.accessToken)
    const refreshToken = typeof rawTokens?.refreshToken === 'string' && rawTokens.refreshToken.trim() ? rawTokens.refreshToken.trim() : null
    const expiresAt = normalizeExpiresAt(rawTokens?.expiresAt)
    const accountId =
      (typeof rawTokens?.accountId === 'string' && rawTokens.accountId.trim() ? rawTokens.accountId.trim() : null) ||
      extractOpenAiAccountId(accessToken)

    return {
      userId: OPENAI_SYNC_USER_ID,
      accessToken: accessToken || null,
      refreshToken,
      expiresAt,
      accountId,
    }
  } catch {
    return {
      userId: OPENAI_SYNC_USER_ID,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      accountId: null,
    }
  }
}

function getSupabaseRefreshConfig(): { url: string; anonKey: string } | null {
  const url = String(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '')
  const anonKey = String(process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '')
  return url && anonKey ? { url, anonKey } : null
}

function shouldRefresh(expiresAt: string | null, skewMs = 5 * 60 * 1000): boolean {
  if (!expiresAt) return false
  const expiresMs = new Date(expiresAt).getTime()
  return Number.isFinite(expiresMs) && expiresMs - Date.now() <= skewMs
}

async function refreshElectronAppAuthSession(refreshToken: string): Promise<StoredElectronAuthSession | null> {
  const config = getSupabaseRefreshConfig()
  if (!config) return null

  const response = await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })

  if (!response.ok) return null

  const payload = (await response.json().catch(() => null)) as any
  if (!payload?.access_token) return null

  const store = new Conf({ projectName: 'ygg-chat-r', configFileMode: 0o600 })
  const current = (store.get('auth_session') ?? null) as StoredElectronAuthSession | null
  const nextSession = {
    ...(current?.session || {}),
    ...payload,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || refreshToken,
    expires_at:
      typeof payload.expires_at === 'number'
        ? payload.expires_at
        : typeof payload.expires_in === 'number'
          ? Math.floor(Date.now() / 1000) + payload.expires_in
          : current?.session?.expires_at,
  }
  const next: StoredElectronAuthSession = {
    ...(current || {}),
    accessToken: payload.access_token,
    userId: current?.userId || current?.user?.id || nextSession.user?.id || null,
    user: current?.user || nextSession.user || null,
    session: nextSession,
  }

  ;(store as any).set?.('auth_session', next)
  return next
}

export async function syncOpenRouterTokenFromElectronSession(tokenStore: ProviderTokenStore): Promise<void> {
  let record = readElectronAppAuthSession()

  if (record.refreshToken && shouldRefresh(record.expiresAt)) {
    await refreshElectronAppAuthSession(record.refreshToken).catch(() => null)
    record = readElectronAppAuthSession()
  }

  const { userId, accessToken, refreshToken, expiresAt } = record
  if (!userId || !accessToken) return

  tokenStore.upsert({
    provider: 'openrouter',
    userId,
    accessToken,
    refreshToken,
    expiresAt,
    accountId: null,
  })
}

export function syncOpenAiChatGptTokenFromElectronStorage(tokenStore: ProviderTokenStore): void {
  const record = readElectronOpenAiChatGptTokens()

  if (!record.accessToken || !record.accountId) {
    tokenStore.delete('openaichatgpt', record.userId)
    return
  }

  tokenStore.upsert({
    provider: 'openaichatgpt',
    userId: record.userId,
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    accountId: record.accountId,
  })
}
