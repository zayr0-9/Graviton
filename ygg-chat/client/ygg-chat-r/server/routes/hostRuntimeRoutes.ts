import { getServerInternalOrigin, tryGetServerConfig } from '../serverHost.js'
import { readHostExecutionPreferences, saveHostExecutionPreferences } from '../hostExecutionStore.js'
import { getHostPromptStore } from '../hostPromptStore.js'
import { randomUUID } from 'node:crypto'
import { hostEpoch } from '../hostEpoch.js'
import { hostClientPolicy } from './hostClientPolicy.js'
import type { Express } from 'express'
import { HOST_CLIENT_PROTOCOL } from '../../../../shared/hostRuntime.js'
import { disconnectAuth, enableLocalLogin, getAuthManager, publicAuthState } from '../auth/runtime.js'
import { fetchOpenAIUsageStatus } from '../auth/codexUsage.js'
import { getSettingsStore } from '../headlessServer/config/settingsStore.js'

/** Public identity projection only. No credential migration or generic storage/RPC. */
export function registerHostRuntimeRoutes(app: Express, ensureLocalUser: () => void = () => {}): void {
  app.use('/api/host', hostClientPolicy)
  const epoch = hostEpoch
  const store = getSettingsStore()
  let hostId = store.get('host_client_id')
  if (typeof hostId !== 'string') { hostId = randomUUID(); store.set('host_client_id', hostId) }
  const status = () => ({ ...publicAuthState(), epoch })
  app.get('/api/host/runtime', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const config = tryGetServerConfig()
    let port: number | null = null
    try { port = Number(new URL(getServerInternalOrigin()).port) } catch { /* Isolated route fixtures need no listener configuration. */ }
    res.json({ protocol: HOST_CLIENT_PROTOCOL, epoch, hostId, auth: status(),
      network: { bindHost: config?.bindHost ?? null, port, exposure: config?.allowNonLoopbackBind ? 'trusted-network-unprotected' : 'loopback', deviceAuthentication: false },
      capabilities: { browserUi: true, sharedRuns: false } })
  })
  app.get('/api/host/execution-preferences', (_req, res) => res.json(readHostExecutionPreferences()))
  app.patch('/api/host/execution-preferences', (req, res) => {
    try { res.json(saveHostExecutionPreferences(req.body)) }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Settings update failed' }) }
  })
  app.get('/api/host/prompts', (_req, res) => res.json(getHostPromptStore().snapshot()))
  app.put('/api/host/prompts', (req, res) => {
    try { res.json(getHostPromptStore().save(req.body?.expectedRevision, req.body?.prompts, req.body)) }
    catch (error) { res.status((error as any)?.status === 409 ? 409 : 400).json({ error: error instanceof Error ? error.message : 'Invalid prompts', snapshot: (error as any)?.snapshot }) }
  })
  app.get('/api/host/auth/status', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(status()) })
  app.post('/api/host/auth/local', (req, res) => {
    if (req.body?.email || req.body?.password) { res.status(400).json({ error: 'Complete cloud sign-in on the Electron host.' }); return }
    if (publicAuthState().app.userId) {
      res.status(409).json({ error: 'The host is signed into a cloud account. Sign out on the host before switching to local mode.' })
      return
    }
    ensureLocalUser()
    enableLocalLogin()
    res.json(status())
  })
  app.post('/api/host/auth/check', async (_req, res) => {
    try { await getAuthManager().check(); res.json(status()) }
    catch { res.status(503).json({ error: 'Host identity is temporarily unavailable.' }) }
  })
  app.post('/api/host/auth/logout', (_req, res) => { disconnectAuth('app'); res.json(status()) })
  app.post('/api/host/auth/codex/disconnect', (_req, res) => { disconnectAuth('codex'); res.json(status()) })
  app.get('/api/host/auth/codex/usage', async (_req, res) => { res.json(await fetchOpenAIUsageStatus()) })
  app.get('/api/host/auth/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const send = () => {
      if (!res.destroyed && !res.writableEnded && !res.write(`data: ${JSON.stringify(status())}\n\n`)) res.end()
    }
    const unsubscribe = getAuthManager().subscribe(send)
    send()
    const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n') }, 15000)
    const cleanup = () => { clearInterval(heartbeat); unsubscribe() }
    res.once('close', cleanup)
    req.once('aborted', cleanup)
  })
}
