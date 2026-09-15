import { getAuthManager } from './runtime.js'
import { AuthFailure } from './authSessionManager.js'
export interface OpenAIUsageWindow { usedPercent: number | null; resetAtIso: string | null; limitWindowSeconds: number | null }
export interface OpenAIUsageSnapshot {
  planType: string | null
  session: OpenAIUsageWindow
  weekly: OpenAIUsageWindow
  reviews: OpenAIUsageWindow
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null
  fetchedAtIso: string
}
export type OpenAIUsageResult = { type: 'success'; data: OpenAIUsageSnapshot } | { type: 'unauthenticated' | 'error'; error: string }
const number = (value: unknown): number | null => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
function windowUsage(value: any, header: string | null): OpenAIUsageWindow {
  const seconds = number(value?.reset_at)
  const date = seconds === null ? NaN : seconds * 1000
  return { usedPercent: number(value?.used_percent) ?? number(header), resetAtIso: Number.isFinite(date) && Math.abs(date) <= 8.64e15 ? new Date(date).toISOString() : null, limitWindowSeconds: number(value?.limit_window_seconds) }
}
export async function fetchOpenAIUsageStatus(): Promise<OpenAIUsageResult> {
  try {
    const owner = getAuthManager()
    let credential = await owner.resolve('codex')
    const request = () => fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json', 'ChatGPT-Account-Id': credential.userId },
    })
    let response = await request()
    if (response.status === 401) {
      await response.body?.cancel()
      credential = await owner.resolve('codex', { sessionId: credential.sessionId, rejectedRevision: credential.revision })
      response = await request()
      if (response.status === 401) { owner.requireReconnect('codex'); return { type: 'unauthenticated', error: 'Reconnect ChatGPT to view usage.' } }
    }
    if (!response.ok) return { type: 'error', error: `ChatGPT usage is unavailable (${response.status}).` }
    const payload = await response.json() as any
    return { type: 'success', data: {
      planType: typeof payload?.plan_type === 'string' ? payload.plan_type : null,
      session: windowUsage(payload?.rate_limit?.primary_window, response.headers.get('x-codex-primary-used-percent')),
      weekly: windowUsage(payload?.rate_limit?.secondary_window, response.headers.get('x-codex-secondary-used-percent')),
      reviews: windowUsage(payload?.code_review_rate_limit?.primary_window, null),
      credits: payload?.credits ? { hasCredits: Boolean(payload.credits.has_credits), unlimited: Boolean(payload.credits.unlimited), balance: number(payload.credits.balance) } : null,
      fetchedAtIso: new Date().toISOString(),
    } }
  } catch (error) {
    return { type: error instanceof AuthFailure && error.category === 'reauth_required' ? 'unauthenticated' : 'error', error: error instanceof AuthFailure ? error.message : 'Could not load ChatGPT usage. Try again.' }
  }
}
