import type { Express } from 'express'
import { JWT_CLAIM_PATH } from '../../../src/features/chats/openaiOAuth.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'

interface RegisterProviderAuthRoutesDeps {
  tokenStore: ProviderTokenStore
}

const DEFAULT_REMOTE_API_BASE = 'https://webdrasil-production.up.railway.app/api'
const DEFAULT_OPENROUTER_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'anthropic/claude-3.7-sonnet',
  'google/gemini-2.5-flash',
]

function getRemoteApiBase(): string {
  const raw = process.env.YGG_API_URL || process.env.VITE_API_URL || DEFAULT_REMOTE_API_BASE
  return String(raw).replace(/\/+$/, '')
}

function normalizeAuthorizationToken(token: string | null | undefined): string {
  return String(token || '').replace(/^Bearer\s+/i, '').trim()
}

function extractModelNames(payload: any): string[] {
  const models = Array.isArray(payload?.models) ? payload.models : []
  const names = models
    .map((model: any) => {
      if (typeof model === 'string') return model.trim()
      if (model && typeof model.name === 'string') return model.name.trim()
      if (model && typeof model.id === 'string') return model.id.trim()
      return ''
    })
    .filter((modelName: string): modelName is string => Boolean(modelName))

  return Array.from(new Set(names))
}

async function fetchOpenRouterModelsFromRemote(accessToken: string): Promise<string[]> {
  const normalizedToken = normalizeAuthorizationToken(accessToken)
  if (!normalizedToken) return []

  const response = await fetch(`${getRemoteApiBase()}/models/openrouter`, {
    headers: {
      Authorization: `Bearer ${normalizedToken}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`Remote OpenRouter models fetch failed: HTTP ${response.status}`)
  }

  const payload = await response.json().catch(() => ({}))
  return extractModelNames(payload)
}

function decodeJwtPayload(token: string): any | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const payload = parts[1]
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

function extractAccountId(accessToken: string): string | null {
  const decoded = decodeJwtPayload(accessToken)
  if (!decoded) return null
  const authClaim = decoded[JWT_CLAIM_PATH]
  return authClaim?.chatgpt_account_id || null
}

export function registerProviderAuthRoutes(app: Express, deps: RegisterProviderAuthRoutesDeps): void {
  const { tokenStore } = deps

  const normalizePayload = (body: any) => {
    const {
      userId,
      user_id,
      accessToken,
      access_token,
      refreshToken,
      refresh_token,
      expiresAt,
      expires_at,
      accountId,
      account_id,
    } = body ?? {}

    const effectiveUserId = userId ?? user_id
    const effectiveAccessToken = accessToken ?? access_token
    const rawExpiresAt = expiresAt ?? expires_at ?? null
    const normalizedExpiresAt =
      typeof rawExpiresAt === 'number'
        ? new Date(rawExpiresAt).toISOString()
        : typeof rawExpiresAt === 'string' && rawExpiresAt.trim()
          ? Number.isFinite(Number(rawExpiresAt))
            ? new Date(Number(rawExpiresAt)).toISOString()
            : rawExpiresAt
          : null

    return {
      userId: effectiveUserId,
      accessToken: effectiveAccessToken,
      refreshToken: (refreshToken ?? refresh_token ?? null) as string | null,
      expiresAt: normalizedExpiresAt,
      accountId: accountId ?? account_id ?? null,
    }
  }

  const registerTokenRoutes = (providerSlug: 'openai' | 'openrouter', providerKey: string, opts?: { deriveAccountId?: boolean }) => {
    app.post(`/api/provider-auth/${providerSlug}/token`, (req, res) => {
      const payload = normalizePayload(req.body)

      if (!payload.userId || !payload.accessToken) {
        res.status(400).json({
          success: false,
          error: 'userId (or user_id) and accessToken (or access_token) are required',
        })
        return
      }

      const accountId = opts?.deriveAccountId ? payload.accountId ?? extractAccountId(String(payload.accessToken)) : payload.accountId
      if (opts?.deriveAccountId && !accountId) {
        res.status(400).json({
          success: false,
          error: 'accountId is required (or must be derivable from access token JWT claim).',
        })
        return
      }

      tokenStore.upsert({
        provider: providerKey,
        userId: String(payload.userId),
        accessToken: String(payload.accessToken),
        refreshToken: payload.refreshToken,
        expiresAt: payload.expiresAt,
        accountId: accountId ? String(accountId) : null,
      })

      res.json({ success: true })
    })

    app.get(`/api/provider-auth/${providerSlug}/token`, (req, res) => {
      const userId = String(req.query.userId ?? req.query.user_id ?? '')
      if (!userId) {
        res.status(400).json({ success: false, error: 'userId query param is required' })
        return
      }

      const tokenRecord = tokenStore.get(providerKey, userId)
      res.json({ success: true, hasToken: Boolean(tokenRecord) })
    })

    app.delete(`/api/provider-auth/${providerSlug}/token`, (req, res) => {
      const userId = String(req.query.userId ?? req.query.user_id ?? '')
      if (!userId) {
        res.status(400).json({ success: false, error: 'userId query param is required' })
        return
      }

      tokenStore.delete(providerKey, userId)
      res.json({ success: true })
    })
  }

  registerTokenRoutes('openai', 'openaichatgpt', { deriveAccountId: true })
  registerTokenRoutes('openrouter', 'openrouter')

  app.get('/api/provider-auth/models', async (req, res) => {
    const userId = String(req.query.userId ?? req.query.user_id ?? '').trim()
    let openRouterModels = [...DEFAULT_OPENROUTER_MODELS]

    if (userId) {
      const tokenRecord = tokenStore.get('openrouter', userId)
      const storedAccessToken = normalizeAuthorizationToken(tokenRecord?.accessToken)

      if (storedAccessToken) {
        try {
          const remoteModels = await fetchOpenRouterModelsFromRemote(storedAccessToken)
          if (remoteModels.length > 0) {
            openRouterModels = remoteModels
          }
        } catch (error) {
          console.warn('[providerAuthRoutes] Falling back to default OpenRouter models:', error)
        }
      }
    }

    res.json({
      success: true,
      providers: [
        {
          name: 'openaichatgpt',
          models: [
            'gpt-5.5',
            'gpt-5.5-pro',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.4-pro',
            'gpt-5.3-codex',
            'gpt-4o',
          ],
        },
        {
          name: 'openrouter',
          models: openRouterModels,
        },
        {
          name: 'lmstudio',
          models: [
            'local-model',
          ],
        },
      ],
    })
  })
}
