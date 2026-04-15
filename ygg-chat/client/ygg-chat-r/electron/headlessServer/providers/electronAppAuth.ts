import Conf from 'conf'
import type { ProviderTokenStore } from './tokenStore.js'

export type StoredElectronAuthSession = {
  userId?: string | null
  accessToken?: string | null
  user?: { id?: string | null } | null
  session?: {
    access_token?: string | null
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
    return new Date(value).toISOString()
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

export function readElectronAppAuthSession(): { userId: string | null; accessToken: string | null } {
  try {
    const store = new Conf({
      projectName: 'ygg-chat-r',
      configFileMode: 0o600,
    })

    const authSession = (store.get('auth_session') ?? null) as StoredElectronAuthSession | null
    const userId = String(authSession?.userId || authSession?.user?.id || authSession?.session?.user?.id || '').trim() || null
    const accessToken = normalizeAuthorizationToken(authSession?.accessToken || authSession?.session?.access_token)

    if (!userId || !accessToken || accessToken === 'electron-local-token') {
      return { userId: null, accessToken: null }
    }

    return { userId, accessToken }
  } catch {
    return { userId: null, accessToken: null }
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

export function syncOpenRouterTokenFromElectronSession(tokenStore: ProviderTokenStore): void {
  const { userId, accessToken } = readElectronAppAuthSession()
  if (!userId || !accessToken) return

  tokenStore.upsert({
    provider: 'openrouter',
    userId,
    accessToken,
    refreshToken: null,
    expiresAt: null,
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
