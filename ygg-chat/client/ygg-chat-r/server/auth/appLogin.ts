import { randomUUID } from 'node:crypto'
import { acceptAppSession, getAuthManager } from './runtime.js'
import { supabaseConfig } from './refreshAdapters.js'

let flowVersion = 0
let pending: { state: string; generation: number; expires: number } | null = null
const railway = () => (process.env.VITE_API_URL || process.env.YGG_API_URL || 'https://webdrasil-production.up.railway.app/api').replace(/\/api\/?$/, '')
export function startAppLogin(provider: string, oob = false): string {
  if (provider !== 'google' && provider !== 'github') throw new Error('Unsupported login provider')
  flowVersion++
  const config = supabaseConfig()
  pending = { state: randomUUID(), generation: getAuthManager().generation('app'), expires: Date.now() + 600_000 }
  const redirect = oob ? `${railway()}/auth/callback` : `yggchat://auth/callback?flow=${pending.state}`
  const url = new URL(`${config.url}/auth/v1/authorize`)
  url.searchParams.set('provider', provider)
  url.searchParams.set('redirect_to', redirect)
  return url.toString()
}
export function cancelAppLogin(): void { flowVersion++; pending = null }
async function complete(access: string, refresh: string) {
  const flow = pending
  if (!flow || flow.expires < Date.now() || flow.generation !== getAuthManager().generation('app')) throw new Error('Login expired or cancelled')
  const version = flowVersion
  pending = null
  return acceptAppSession(access, refresh, () => version === flowVersion)
}
export async function completeAppCallback(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'yggchat:' || url.hostname !== 'auth' || url.pathname !== '/callback' || url.searchParams.get('flow') !== pending?.state) throw new Error('Invalid login callback')
  const params = new URLSearchParams(url.hash.slice(1))
  return complete(params.get('access_token') || '', params.get('refresh_token') || '')
}
export async function completeAppCode(code: string) {
  if (!pending || pending.expires < Date.now()) throw new Error('Start login before entering a code')
  const flow = pending
  const response = await fetch(`${railway()}/api/auth/oob/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error('Invalid or expired login code')
  const body = await response.json() as any
  if (pending !== flow) throw new Error('Login cancelled')
  return complete(body.access_token, body.refresh_token)
}
