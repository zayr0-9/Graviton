import crypto from 'node:crypto'
import express, { type Express, type RequestHandler } from 'express'
import type { Server } from 'node:http'
import { tryGetServerConfig } from '../serverHost.js'
import { acceptCodexSession, getAuthManager } from '../auth/runtime.js'
import { jwtMetadata } from '../auth/refreshAdapters.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
interface Flow { verifier: string; generation: number; sessionId?: string | null; createdAt: number; status: 'pending' | 'exchanging' | 'completed' | 'failed' }
const flows = new Map<string, Flow>()
let callbackServer: Server | null = null
let cleanup: ReturnType<typeof setInterval> | undefined

async function exchange(code: unknown, state: unknown): Promise<void> {
  if (typeof code !== 'string' || typeof state !== 'string') throw new Error('Missing code or state')
  const flow = flows.get(state)
  const owner = getAuthManager()
  if (!flow || flow.createdAt < Date.now() - 600_000 || flow.generation !== owner.generation('codex')) throw new Error('Expired or cancelled login')
  if (flow.status === 'completed') return
  if (flow.status !== 'pending') throw new Error('Login already being processed')
  flow.status = 'exchanging'
  try {
    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: flow.verifier, redirect_uri: REDIRECT_URI }),
    })
    if (!response.ok) throw new Error('Token exchange failed')
    const tokens = await response.json() as any
    const claims = jwtMetadata(tokens.access_token || '')
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || typeof accountId !== 'string' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('Invalid login response')
    if (flow.generation !== owner.generation('codex') || flows.get(state) !== flow) throw new Error('Login cancelled')
    acceptCodexSession({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accountId,
      expiresAt: Date.now() + tokens.expires_in * 1000, email: jwtMetadata(tokens.id_token || '').email ?? claims.email ?? null })
    flow.status = 'completed'
    flow.sessionId = owner.snapshot('codex').sessionId
    flow.verifier = ''
  } catch (error) { flow.status = 'failed'; flow.verifier = ''; throw error }
}
const callback: RequestHandler = async (req, res) => {
  try {
    await exchange(req.query.code, req.query.state)
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    res.type('html').send('<!doctype html><title>ChatGPT connected</title><h1>ChatGPT connected</h1><p>You can close this window and return to Graviton.</p>')
  } catch { res.status(400).send('Sign-in expired or failed. Start a new sign-in from Graviton.') }
}
export function startOpenAiOAuthCallbackServer(): void {
  const policy = tryGetServerConfig()?.oauth
  const app = express()
  app.get('/auth/callback', callback)
  callbackServer = app.listen(policy?.callbackPort ?? 1455, policy?.callbackHost ?? '127.0.0.1')
  callbackServer.on('error', () => console.warn('[OAuth] Callback listener unavailable; use manual completion.'))
}
export function stopOpenAiOAuth(): void {
  if (cleanup) clearInterval(cleanup)
  cleanup = undefined
  callbackServer?.close()
  callbackServer = null
  flows.clear()
}
export function registerOpenAiOAuthRoutes(app: Express): void {
  if (cleanup) clearInterval(cleanup)
  cleanup = setInterval(() => { for (const [id, flow] of flows) if (flow.createdAt < Date.now() - 600_000) flows.delete(id) }, 60_000)
  cleanup.unref?.()
  app.post('/api/openai/auth/start', (_req, res) => {
    flows.clear() // one active account connection flow
    const verifier = crypto.randomBytes(32).toString('base64url')
    const state = crypto.randomBytes(24).toString('hex')
    flows.set(state, { verifier, createdAt: Date.now(), generation: getAuthManager().generation('codex'), status: 'pending' })
    const url = new URL('https://auth.openai.com/oauth/authorize')
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      scope: 'openid profile email offline_access', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', state, id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs' })) url.searchParams.set(key, value)
    res.json({ success: true, authUrl: url.toString(), state })
  })
  app.post('/api/openai/auth/complete', (req, res) => {
    const flow = flows.get(req.body?.state)
    if (!flow || flow.createdAt < Date.now() - 600_000 || flow.status === 'failed') { res.status(400).json({ success: false, error: 'Expired or failed login' }); return }
    if (flow.status !== 'completed') { res.json({ success: false, pending: true }); return }
    const snapshot = getAuthManager().snapshot('codex')
    if (snapshot.sessionId !== flow.sessionId || snapshot.status === 'reauth_required' || snapshot.status === 'signed_out') { res.status(409).json({ success: false, error: 'Connection changed; start a new login.' }); return }
    res.json({ success: true, snapshot, email: snapshot.email })
  })
  app.post('/api/openai/auth/exchange', async (req, res) => {
    try { await exchange(req.body?.code, req.body?.state); res.json({ success: true, snapshot: getAuthManager().snapshot('codex') }) }
    catch { res.status(400).json({ success: false, error: 'Expired or failed login' }) }
  })
  app.post('/api/openai/auth/refresh', (_req, res) => { res.status(410).json({ error: 'Credentials are server-owned. Refresh is automatic.' }) })
  app.get('/auth/callback', callback)
  app.get('/api/openai/models', (_req, res) => {
    const configured = Number(process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS)
    const contextLength = Number.isFinite(configured) && configured > 0 ? Math.max(1000, Math.min(2_000_000, Math.floor(configured))) : 258_000
    const models = ['gpt-5.5', 'gpt-6-astra', 'gpt-5.5-pro', 'gpt-5.3-codex', 'gpt-4o'].map(id => ({
      id, name: id, displayName: id, description: id, contextLength, maxCompletionTokens: id === 'gpt-4o' || id === 'gpt-5.3-codex' ? 16384 : 128000,
      version: 'chatgpt', inputTokenLimit: contextLength, outputTokenLimit: id === 'gpt-4o' || id === 'gpt-5.3-codex' ? 16384 : 128000,
      promptCost: 0, completionCost: 0, requestCost: 0, thinking: true, supportsImages: true, supportsWebSearch: false,
      supportsStructuredOutputs: true, inputModalities: ['text', 'image'], outputModalities: ['text'], isFreeTier: false,
    }))
    res.json({ models })
  })
}
