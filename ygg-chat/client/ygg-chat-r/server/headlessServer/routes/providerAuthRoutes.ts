import { getAuthManager, disconnectAuth } from '../../auth/runtime.js'
import type { Express } from 'express'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import { fetchOpenRouterByokModels, OPENROUTER_BYOK_PROVIDER_KEY } from '../providers/hyperRouterOpenRouterProvider.js'

interface RegisterProviderAuthRoutesDeps {
  tokenStore: ProviderTokenStore
}

const DEFAULT_OPENROUTER_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'anthropic/claude-3.7-sonnet',
  'google/gemini-2.5-flash',
]
const DEFAULT_ZAI_MODELS = ['glm-5.1', 'glm-4.6']
const DEFAULT_BEDROCK_MODELS = [
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'anthropic.claude-3-5-haiku-20241022-v1:0',
  'anthropic.claude-3-sonnet-20240229-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
]

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

  const registerTokenRoutes = (providerSlug: 'openai' | 'openrouter-byok' | 'zai' | 'bedrock', providerKey: string, opts?: { deriveAccountId?: boolean }) => {
    app.post(`/api/provider-auth/${providerSlug}/token`, (req, res) => {
      if (providerSlug === 'openai') { res.status(410).json({ error: 'OAuth tokens are server-owned. Use the login flow.' }); return }
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
      if (providerSlug === 'openai') { const snapshot = getAuthManager().snapshot('codex'); res.json({ success: true, hasToken: snapshot.status === 'ready' || snapshot.status === 'refreshing', snapshot }); return }
      const userId = String(req.query.userId ?? req.query.user_id ?? '')
      if (!userId) {
        res.status(400).json({ success: false, error: 'userId query param is required' })
        return
      }

      const tokenRecord = tokenStore.get(providerKey, userId)
      res.json({ success: true, hasToken: Boolean(tokenRecord) })
    })

    app.delete(`/api/provider-auth/${providerSlug}/token`, (req, res) => {
      if (providerSlug === 'openai') { disconnectAuth('codex'); res.json({ success: true }); return }
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
  registerTokenRoutes('zai', 'zai')
  registerTokenRoutes('bedrock', 'bedrock')
  registerTokenRoutes('openrouter-byok', OPENROUTER_BYOK_PROVIDER_KEY)

  app.get('/api/provider-auth/openrouter-byok/models', async (_req, res) => {
    try {
      res.json({ success: true, models: await fetchOpenRouterByokModels() })
    } catch (error) {
      res.status(502).json({ success: false, error: error instanceof Error ? error.message : 'Failed to load OpenRouter models' })
    }
  })

  app.get('/api/provider-auth/models', async (_req, res) => {

    res.json({
      success: true,
      providers: [
        {
          name: 'openaichatgpt',
          models: [
            'gpt-6-sol',
            'gpt-6.1-sol',
            'gpt-6-luna',
            'gpt-6-astra',
            'gpt-5.6-terra',
            'gpt-5.5',
          ],
        },
        {
          // The user's own OpenRouter key; the live list is /api/provider-auth/openrouter-byok/models.
          name: 'openrouterbyok',
          models: DEFAULT_OPENROUTER_MODELS,
        },
        {
          name: 'lmstudio',
          models: [
            'local-model',
          ],
        },
        {
          name: 'zai',
          models: DEFAULT_ZAI_MODELS,
        },
        {
          name: 'bedrock',
          models: DEFAULT_BEDROCK_MODELS,
        },
      ],
    })
  })
}
