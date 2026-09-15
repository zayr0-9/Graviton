import { afterEach, describe, expect, it, vi } from 'vitest'
import { expiryMs, refreshCredential } from '../../../auth/refreshAdapters.js'
import type { Credential } from '../../../auth/authSessionManager.js'

const current: Credential = { sessionId: 'session', revision: 0, userId: 'account', accessToken: 'old', refreshToken: 'refresh', expiresAt: 1 }
const token = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe('provider refresh adapters', () => {
  it('normalizes numeric seconds, numeric strings and ISO dates consistently', () => {
    expect(expiryMs(1_800_000_000)).toBe(1_800_000_000_000)
    expect(expiryMs('1800000000')).toBe(1_800_000_000_000)
    expect(expiryMs('1800000000000')).toBe(1_800_000_000_000)
    expect(expiryMs('2027-01-15T08:00:00Z')).toBe(Date.parse('2027-01-15T08:00:00Z'))
    expect(expiryMs('garbage')).toBeNull()
  })
  it('preserves a refresh token when Codex does not rotate it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: token({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } }), expires_in: 3600 }))))
    const result = await refreshCredential('codex', current, new AbortController().signal)
    expect(result.refreshToken).toBe('refresh')
    expect(result.userId).toBe('account')
  })
  it('classifies an invalid grant without exposing the raw provider body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant', detail: 'secret' }), { status: 400 })))
    await expect(refreshCredential('codex', current, new AbortController().signal)).rejects.toMatchObject({ category: 'reauth_required' })
  })
  it('does not classify rate limiting as revoked credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })))
    await expect(refreshCredential('codex', current, new AbortController().signal)).rejects.toMatchObject({ category: 'temporarily_unavailable' })
  })
  it('reports missing main-process Supabase config rather than returning stale credentials', async () => {
    for (const key of ['VITE_SUPABASE_URL', 'SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']) vi.stubEnv(key, '')
    await expect(refreshCredential('app', current, new AbortController().signal)).rejects.toMatchObject({ category: 'configuration_error' })
  })
})
