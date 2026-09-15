import type { AuthSlot } from '../../../../shared/auth.js'
import { AuthFailure, type Credential } from './authSessionManager.js'

export function jwtMetadata(token: string): any {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
export function expiryMs(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null
  const numeric = Number(value)
  const parsed = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}
export function supabaseConfig(): { url: string; key: string } {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) throw new AuthFailure('app', 'configuration_error', 'Supabase authentication is not configured in this installation.')
  return { url: url.replace(/\/+$/, ''), key }
}
export async function refreshCredential(slot: AuthSlot, current: Credential, signal: AbortSignal): Promise<Omit<Credential, 'sessionId' | 'revision'>> {
  let response: Response
  if (slot === 'app') {
    const config = supabaseConfig()
    response = await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', signal, headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    })
  } else {
    response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken!, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
    })
  }
  const payload = await response.json().catch(() => null) as any
  if (!response.ok) {
    const code = String(payload?.error_code || payload?.code || payload?.error?.code || payload?.error || '')
    const permanent = ['invalid_grant', 'refresh_token_not_found', 'refresh_token_already_used', 'refresh_token_reused', 'refresh_token_expired', 'session_not_found'].includes(code) || response.status === 401
    const retryAfter = response.headers.get('retry-after')
    const seconds = retryAfter ? Number(retryAfter) : NaN
    const retryAfterMs = retryAfter ? (Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now())) : undefined
    throw new AuthFailure(slot, permanent ? 'reauth_required' : 'temporarily_unavailable', permanent ? 'This connection needs you to sign in again.' : 'Authentication service is temporarily unavailable. It will retry automatically.', Number.isFinite(retryAfterMs) ? retryAfterMs : undefined)
  }
  if (typeof payload?.access_token !== 'string') throw new AuthFailure(slot, 'temporarily_unavailable', 'Authentication service returned an incomplete response.')
  const metadata = jwtMetadata(payload.access_token)
  const userId = slot === 'app' ? payload.user?.id : metadata['https://api.openai.com/auth']?.chatgpt_account_id
  const expiresAt = expiryMs(payload.expires_at) ?? (Number.isFinite(payload.expires_in) ? Date.now() + payload.expires_in * 1000 : expiryMs(metadata.exp))
  if (typeof userId !== 'string' || !userId || !expiresAt || expiresAt <= Date.now() || (payload.refresh_token != null && typeof payload.refresh_token !== 'string')) throw new AuthFailure(slot, 'temporarily_unavailable', 'Authentication service returned an invalid session.')
  return { userId, email: payload.user?.email ?? current.email, accessToken: payload.access_token,
    refreshToken: payload.refresh_token || current.refreshToken, expiresAt }
}
