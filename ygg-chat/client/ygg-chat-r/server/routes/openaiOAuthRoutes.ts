// server/routes/openaiOAuthRoutes.ts
//
// OpenAI ChatGPT OAuth authentication endpoints (personal ChatGPT Plus/Pro
// subscriptions), plus the dedicated OAuth callback server on port 1455.
// Extracted verbatim from localServer.ts setupServer().
//
// Lifecycle: registerOpenAiOAuthRoutes() wires the /api/openai/* routes and
// (re)starts the pending-flow cleanup timer. startOpenAiOAuthCallbackServer()
// is called by setupServer() only when the host config enables OAuth.
// stopOpenAiOAuth() is called from stopLocalServer().

import cors from 'cors'
import crypto from 'crypto'
import express, { type Express } from 'express'
import { tryGetServerConfig } from '../serverHost.js'

// OAuth Configuration (from OpenAI Codex CLI)
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const OPENAI_SCOPE = 'openid profile email offline_access'

// OAuth state storage (in-memory, per session)
const oauthPendingFlows = new Map<string, { verifier: string; state: string; createdAt: number }>()
// Storage for completed OAuth tokens (keyed by state, for frontend to retrieve)
const oauthCompletedTokens = new Map<
  string,
  {
    accessToken: string
    refreshToken: string
    expiresAt: number
    accountId: string
    email: string | null
    createdAt: number
  }
>()

let oauthCallbackServer: any = null // OAuth callback server on port 1455
let oauthCleanupInterval: NodeJS.Timeout | null = null

// Helper: Generate PKCE verifier and challenge
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.randomBytes(32)
  const verifier = verifierBytes.toString('base64url')
  const challengeHash = crypto.createHash('sha256').update(verifier).digest()
  const challenge = challengeHash.toString('base64url')
  return { verifier, challenge }
}

// Start OAuth callback server on port 1455
// This is a dedicated server just for handling OAuth redirects
export function startOpenAiOAuthCallbackServer(): void {
  const oauthApp = express()
  oauthApp.use(cors())

  oauthApp.get('/auth/callback', async (req, res) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string }

      if (!code || !state) {
        res.status(400).send('Missing code or state parameter')
        return
      }

      const pendingFlow = oauthPendingFlows.get(state)
      if (!pendingFlow) {
        res.status(400).send('Invalid or expired state. Please try again.')
        return
      }

      // Exchange code for tokens
      const tokenRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OPENAI_CLIENT_ID,
          code,
          code_verifier: pendingFlow.verifier,
          redirect_uri: OPENAI_REDIRECT_URI,
        }),
      })

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text()
        console.error('[OAuthServer] Token exchange failed:', tokenRes.status, errorText)
        res.status(400).send('Token exchange failed. Please try again.')
        oauthPendingFlows.delete(state)
        return
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        id_token?: string
      }

      if (!tokens.access_token || !tokens.refresh_token) {
        res.status(400).send('Invalid token response')
        oauthPendingFlows.delete(state)
        return
      }

      const decodeJwtPayload = (token: string | undefined): any | null => {
        if (!token) return null
        try {
          const parts = token.split('.')
          if (parts.length !== 3) return null
          const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
          const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
          return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
        } catch (e) {
          console.error('[OAuthServer] Failed to decode JWT:', e)
          return null
        }
      }

      const accessPayload = decodeJwtPayload(tokens.access_token)
      const idPayload = decodeJwtPayload(tokens.id_token)
      const accountId = accessPayload?.['https://api.openai.com/auth']?.chatgpt_account_id || ''
      const rawEmail = typeof idPayload?.email === 'string' ? idPayload.email : typeof accessPayload?.email === 'string' ? accessPayload.email : ''
      const email = rawEmail.trim() || null

      // Store tokens for frontend to retrieve
      const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000
      oauthCompletedTokens.set(state, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
        accountId,
        email,
        createdAt: Date.now(),
      })

      // Clean up pending flow
      oauthPendingFlows.delete(state)

      // Return success page with token data
      const successHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>OpenAI Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; }
    .container { text-align: center; padding: 40px; background: rgba(255,255,255,0.1); border-radius: 16px; backdrop-filter: blur(10px); max-width: 500px; }
    h1 { color: #10b981; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
    .token-box { background: rgba(0,0,0,0.3); padding: 16px; border-radius: 8px; margin: 16px 0; text-align: left; }
    .token-box code { word-break: break-all; font-size: 11px; color: #a5f3fc; }
    .copy-btn { background: #10b981; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 14px; margin-top: 16px; }
    .copy-btn:hover { background: #059669; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✓</div>
    <h1>Authentication Successful!</h1>

    <button class="copy-btn" onclick="copyCode()">Copy Code</button>
    <p style="font-size: 12px; opacity: 0.6; margin-top: 24px;">Or close this window if the app detected the callback automatically.</p>
  </div>
  <script>
    function copyCode() {
      navigator.clipboard.writeText(document.getElementById('authCode').textContent);
      document.querySelector('.copy-btn').textContent = 'Copied!';
      setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy Code', 2000);
    }
    // Try to notify parent/opener
    if (window.opener) {
      window.opener.postMessage({
        type: 'openai_oauth_success',
        accessToken: ${JSON.stringify(tokens.access_token)},
        refreshToken: ${JSON.stringify(tokens.refresh_token)},
        expiresIn: ${tokens.expires_in || 3600},
        accountId: ${JSON.stringify(accountId)}
      }, '*');
    }
  </script>
</body>
</html>
      `
      res.setHeader('Content-Type', 'text/html')
      res.send(successHtml)
    } catch (error) {
      console.error('[OAuthServer] Callback error:', error)
      res.status(500).send('Authentication failed. Please try again.')
    }
  })

  const oauthPolicy = tryGetServerConfig()?.oauth
  const callbackHost = oauthPolicy?.callbackHost ?? '127.0.0.1'
  const callbackPort = oauthPolicy?.callbackPort ?? 1455
  oauthCallbackServer = oauthApp.listen(callbackPort, callbackHost, () => {
    console.log(`[OAuthServer] OAuth callback server running on http://${callbackHost}:${callbackPort}`)
  })

  oauthCallbackServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[OAuthServer] Port ${callbackPort} already in use, OAuth callbacks may not work`)
    } else {
      console.error('[OAuthServer] Server error:', err)
    }
  })
}

// Stop the OAuth pending-flow cleanup timer and close the callback server.
// Called from stopLocalServer().
export function stopOpenAiOAuth(): void {
  if (oauthCleanupInterval) {
    clearInterval(oauthCleanupInterval)
    oauthCleanupInterval = null
  }

  // Close OAuth callback server if running
  if (oauthCallbackServer) {
    oauthCallbackServer.close(() => {
      console.log('[OAuthServer] OAuth callback server closed')
    })
    oauthCallbackServer = null
  }
}

export function registerOpenAiOAuthRoutes(app: Express): void {
  // A fresh registration mirrors the old per-setupServer closure state.
  oauthPendingFlows.clear()
  oauthCompletedTokens.clear()

  // Clean up old pending flows and completed tokens (older than 10 minutes).
  // The handle is module-level so stopOpenAiOAuth can clear it.
  if (oauthCleanupInterval) {
    clearInterval(oauthCleanupInterval)
  }
  oauthCleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [state, flow] of oauthPendingFlows.entries()) {
      if (now - flow.createdAt > 10 * 60 * 1000) {
        oauthPendingFlows.delete(state)
      }
    }
    for (const [state, tokens] of oauthCompletedTokens.entries()) {
      if (now - tokens.createdAt > 10 * 60 * 1000) {
        oauthCompletedTokens.delete(state)
      }
    }
  }, 60 * 1000)

  // POST /api/openai/auth/start - Start OAuth flow
  app.post('/api/openai/auth/start', async (_req, res) => {
    try {
      const { verifier, challenge } = await generatePKCE()
      const state = crypto.randomBytes(16).toString('hex')

      // Store the flow
      oauthPendingFlows.set(state, { verifier, state, createdAt: Date.now() })

      // Build authorization URL
      const url = new URL(OPENAI_AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', OPENAI_CLIENT_ID)
      url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI)
      url.searchParams.set('scope', OPENAI_SCOPE)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      url.searchParams.set('id_token_add_organizations', 'true')
      url.searchParams.set('codex_cli_simplified_flow', 'true')
      url.searchParams.set('originator', 'codex_cli_rs')

      res.json({
        success: true,
        authUrl: url.toString(),
        state,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth start error:', error)
      res.status(500).json({ success: false, error: 'Failed to start OAuth flow' })
    }
  })

  // POST /api/openai/auth/complete - Retrieve completed OAuth tokens
  app.post('/api/openai/auth/complete', (req, res) => {
    try {
      const { state } = req.body

      if (!state) {
        res.status(400).json({ success: false, error: 'Missing state parameter' })
        return
      }

      const tokens = oauthCompletedTokens.get(state)
      if (!tokens) {
        // Check if flow is still pending (user hasn't completed auth yet)
        if (oauthPendingFlows.has(state)) {
          res.json({ success: false, pending: true, error: 'Authentication not yet completed' })
          return
        }
        res.status(404).json({ success: false, error: 'Invalid or expired state' })
        return
      }

      // Remove tokens from storage (one-time retrieval)
      oauthCompletedTokens.delete(state)

      res.json({
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        accountId: tokens.accountId,
        email: tokens.email,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth complete error:', error)
      res.status(500).json({ success: false, error: 'Failed to retrieve tokens' })
    }
  })

  // GET /auth/callback - OAuth callback (port 1455 redirects to whichever local API port is active)
  // Note: The actual callback server runs on port 1455
  app.get('/auth/callback', async (req, res) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string }

      if (!code || !state) {
        res.status(400).send('Missing code or state parameter')
        return
      }

      const pendingFlow = oauthPendingFlows.get(state)
      if (!pendingFlow) {
        res.status(400).send('Invalid or expired state. Please try again.')
        return
      }

      // Exchange code for tokens
      const tokenRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OPENAI_CLIENT_ID,
          code,
          code_verifier: pendingFlow.verifier,
          redirect_uri: OPENAI_REDIRECT_URI,
        }),
      })

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text()
        console.error('[LocalServer] OpenAI token exchange failed:', tokenRes.status, errorText)
        res.status(400).send('Token exchange failed. Please try again.')
        oauthPendingFlows.delete(state)
        return
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }

      if (!tokens.access_token || !tokens.refresh_token) {
        res.status(400).send('Invalid token response')
        oauthPendingFlows.delete(state)
        return
      }

      // Extract account ID from JWT
      let accountId = ''
      try {
        const parts = tokens.access_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || ''
        }
      } catch (e) {
        console.error('[LocalServer] Failed to decode JWT:', e)
      }

      // Clean up
      oauthPendingFlows.delete(state)

      // Return success page with token data (will be picked up by frontend)
      const successHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>OpenAI Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; }
    .container { text-align: center; padding: 40px; background: rgba(255,255,255,0.1); border-radius: 16px; backdrop-filter: blur(10px); }
    h1 { color: #10b981; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .success-icon { font-size: 64px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">✓</div>
    <h1>Authentication Successful!</h1>
    <p>You can close this window and return to the app.</p>
    <p style="font-size: 12px; opacity: 0.6;">Your ChatGPT Plus/Pro account is now connected.</p>
  </div>
  <script>
    // Send tokens to opener window if available
    if (window.opener) {
      window.opener.postMessage({
        type: 'openai_oauth_success',
        accessToken: ${JSON.stringify(tokens.access_token)},
        refreshToken: ${JSON.stringify(tokens.refresh_token)},
        expiresIn: ${tokens.expires_in || 3600},
        accountId: ${JSON.stringify(accountId)}
      }, '*');
      setTimeout(() => window.close(), 2000);
    }
  </script>
</body>
</html>
      `
      res.setHeader('Content-Type', 'text/html')
      res.send(successHtml)
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth callback error:', error)
      res.status(500).send('Authentication failed. Please try again.')
    }
  })

  // POST /api/openai/auth/exchange - Exchange code for tokens (manual flow)
  app.post('/api/openai/auth/exchange', async (req, res) => {
    try {
      const { code, state } = req.body

      if (!code || !state) {
        res.status(400).json({ success: false, error: 'Missing code or state' })
        return
      }

      const pendingFlow = oauthPendingFlows.get(state)
      if (!pendingFlow) {
        res.status(400).json({ success: false, error: 'Invalid or expired state' })
        return
      }

      // Exchange code for tokens
      const tokenRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OPENAI_CLIENT_ID,
          code,
          code_verifier: pendingFlow.verifier,
          redirect_uri: OPENAI_REDIRECT_URI,
        }),
      })

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text()
        console.error('[LocalServer] OpenAI token exchange failed:', tokenRes.status, errorText)
        oauthPendingFlows.delete(state)
        res.status(400).json({ success: false, error: 'Token exchange failed' })
        return
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }

      if (!tokens.access_token || !tokens.refresh_token) {
        oauthPendingFlows.delete(state)
        res.status(400).json({ success: false, error: 'Invalid token response' })
        return
      }

      // Extract account ID from JWT
      let accountId = ''
      try {
        const parts = tokens.access_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || ''
        }
      } catch (e) {
        console.error('[LocalServer] Failed to decode JWT:', e)
      }

      oauthPendingFlows.delete(state)

      res.json({
        success: true,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in || 3600,
        accountId,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth exchange error:', error)
      res.status(500).json({ success: false, error: 'Token exchange failed' })
    }
  })

  // POST /api/openai/auth/refresh - Refresh access token
  app.post('/api/openai/auth/refresh', async (req, res) => {
    try {
      const { refreshToken } = req.body

      if (!refreshToken) {
        res.status(400).json({ success: false, error: 'Missing refresh token' })
        return
      }

      const tokenRes = await fetch(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: OPENAI_CLIENT_ID,
        }),
      })

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text()
        console.error('[LocalServer] OpenAI token refresh failed:', tokenRes.status, errorText)
        res.status(401).json({ success: false, error: 'Token refresh failed' })
        return
      }

      const tokens = (await tokenRes.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }

      if (!tokens.access_token || !tokens.refresh_token) {
        res.status(400).json({ success: false, error: 'Invalid token response' })
        return
      }

      // Extract account ID from JWT
      let accountId = ''
      try {
        const parts = tokens.access_token.split('.')
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || ''
        }
      } catch (e) {
        console.error('[LocalServer] Failed to decode JWT:', e)
      }

      res.json({
        success: true,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in || 3600,
        accountId,
      })
    } catch (error) {
      console.error('[LocalServer] OpenAI OAuth refresh error:', error)
      res.status(500).json({ success: false, error: 'Token refresh failed' })
    }
  })

  // GET /api/openai/models - Get available ChatGPT models
  app.get('/api/openai/models', (_req, res) => {
    // Return hardcoded model capabilities with the user's global ChatGPT context override.
    const configuredContextLength = Number(process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS)
    const globalContextLength =
      Number.isFinite(configuredContextLength) && configuredContextLength > 0
        ? Math.max(1_000, Math.min(2_000_000, Math.floor(configuredContextLength)))
        : 258_000
    const models = [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        displayName: 'GPT-5.5',
        description: 'Latest GPT-5.5 frontier model for professional work',
        contextLength: 258000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.5-pro',
        name: 'GPT-5.5 Pro',
        displayName: 'GPT-5.5 Pro',
        description: 'Version of GPT-5.5 that produces smarter and more precise responses',
        contextLength: 258000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        displayName: 'GPT-5.4',
        description: 'Latest GPT-5.4 frontier model for professional work',
        contextLength: 258000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        displayName: 'GPT-5.4 Mini',
        description: 'Strong mini model for coding, computer use, and subagents',
        contextLength: 258000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        displayName: 'GPT-5.4 Pro',
        description: 'Version of GPT-5.4 that produces smarter and more precise responses',
        contextLength: 258000,
        maxCompletionTokens: 128000,
      },
      {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        displayName: 'GPT-5.3 Codex',
        description: 'Latest GPT-5.3 Codex model for coding tasks',
        contextLength: 258000,
        maxCompletionTokens: 16384,
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        displayName: 'GPT-4o',
        description: 'GPT-4o multimodal model',
        contextLength: 128000,
        maxCompletionTokens: 16384,
      },
    ]

    res.json({
      models: models.map(m => ({
        ...m,
        contextLength: globalContextLength,
        version: 'chatgpt',
        inputTokenLimit: globalContextLength,
        outputTokenLimit: m.maxCompletionTokens,
        promptCost: 0,
        completionCost: 0,
        requestCost: 0,
        thinking: true,
        supportsImages: true,
        supportsWebSearch: false,
        supportsStructuredOutputs: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        isFreeTier: false,
      })),
    })
  })
}
