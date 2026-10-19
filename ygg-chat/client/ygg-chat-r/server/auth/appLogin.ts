import { randomUUID } from 'node:crypto'
import { acceptAppSession, getAuthManager } from './runtime.js'
import { supabaseConfig } from './refreshAdapters.js'

let flowVersion = 0
let completedCallback: { state: string; generation: number; result: Awaited<ReturnType<typeof acceptAppSession>> } | null = null
let pending: { state: string; generation: number; expires: number; owner: string; provider: string; oob: boolean; completing: boolean } | null = null
const railway = () => (process.env.VITE_API_URL || process.env.YGG_API_URL || 'https://webdrasil-production.up.railway.app/api').replace(/\/api\/?$/, '')
export function startAppLogin(provider: string, oob = false, owner = 'desktop'): string {
  if (provider !== 'google' && provider !== 'github') throw new Error('Unsupported login provider')
  const generation = getAuthManager().generation('app')
  if (pending && pending.expires > Date.now() && pending.generation === generation) {
    if (pending.owner !== owner || pending.provider !== provider || pending.completing)
      throw Object.assign(new Error('A sign-in attempt is already in progress on the host.'), { code: 'login_busy' })
    // The owning document may switch to the manual-code flow, but another
    // document cannot replace its callback or invalidate its in-flight exchange.
    if (pending.oob !== oob) { flowVersion++; pending = null }
  } else pending = null
  const config = supabaseConfig()
  if (!pending) {
    flowVersion++
    pending = { state: randomUUID(), generation, expires: Date.now() + 600_000, owner, provider, oob, completing: false }
  }
  const redirect = oob ? `${railway()}/auth/callback` : `yggchat://auth/callback?flow=${pending.state}`
  const url = new URL(`${config.url}/auth/v1/authorize`)
  url.searchParams.set('provider', provider)
  url.searchParams.set('redirect_to', redirect)
  return url.toString()
}
export function cancelAppLogin(owner?: string): void {
  if (owner !== undefined && pending?.owner !== owner) return
  flowVersion++; pending = null; completedCallback = null
}
async function complete(access: string, refresh: string) {
  const flow = pending
  if (!flow || flow.expires < Date.now() || flow.generation !== getAuthManager().generation('app')) throw new Error('Login expired or cancelled')
  const version = flowVersion
  flow.completing = true
  try { return await acceptAppSession(access, refresh, () => version === flowVersion) }
  finally { if (pending === flow) pending = null }
}
export async function completeAppCallback(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'yggchat:' || url.hostname !== 'auth' || url.pathname !== '/callback') throw new Error('Invalid login callback')
  const state = url.searchParams.get('flow')
  if (!pending && completedCallback?.state === state && completedCallback.generation === getAuthManager().generation('app')) return completedCallback.result
  if (state !== pending?.state) throw new Error('Invalid login callback')
  if (pending?.completing) throw new Error('Sign-in verification is already in progress')
  const params = new URLSearchParams(url.hash.slice(1))
  const version = flowVersion
  const result = await complete(params.get('access_token') || '', params.get('refresh_token') || '')
  if (version === flowVersion && state) completedCallback = { state, generation: getAuthManager().generation('app'), result }
  return result
}
export async function completeAppCode(code: string, owner = 'desktop') {
  if (!pending || pending.expires < Date.now() || pending.owner !== owner) throw new Error('Start login before entering a code')
  if (pending.completing) throw new Error('Sign-in verification is already in progress')
  const flow = pending
  flow.completing = true
  try {
  const response = await fetch(`${railway()}/api/auth/oob/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error('Invalid or expired login code')
  const body = await response.json() as any
  if (pending !== flow) throw new Error('Login cancelled')
  return await complete(body.access_token, body.refresh_token)
  } finally { if (pending === flow) flow.completing = false }
}
