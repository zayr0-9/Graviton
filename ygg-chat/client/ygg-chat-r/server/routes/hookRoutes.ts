// server/routes/hookRoutes.ts
//
// Managed-hook APIs (/api/hooks, /api/hooks/toggle, /api/hooks/run),
// extracted verbatim from localServer.ts setupServer().

import type { Express } from 'express'
import { listManagedHooks, setManagedHookEnabled } from '../hooks/hookManager.js'
import { runHookRequest } from '../hooks/hookRunner.js'
import { toSafeHookRunRecord } from '../hooks/hookDiagnostics.js'
import type { HookRunRepo } from '../headlessServer/persistence/hookRunRepo.js'

export function registerHookRoutes(app: Express, deps: { hookRunRepo?: HookRunRepo } = {}): void {
  app.get('/api/hooks', async (_req, res) => {
    try {
      const hooks = await listManagedHooks()
      res.json({ success: true, hooks })
    } catch (error) {
      console.error('[LocalServer] Hook list error:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.post('/api/hooks/toggle', async (req, res) => {
    try {
      const { sourceFile, event, entryIndex, handlerIndex, handlerLocation, enabled } = req.body || {}
      const hook = await setManagedHookEnabled({
        sourceFile,
        event,
        entryIndex,
        handlerIndex,
        handlerLocation,
        enabled,
      })
      res.json({ success: true, hook })
    } catch (error) {
      console.error('[LocalServer] Hook toggle error:', error)
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.get('/api/hooks/runs', (req, res) => {
    if (!deps.hookRunRepo) return res.json({ runs: [] })
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : undefined
    const streamId = typeof req.query.streamId === 'string' ? req.query.streamId : undefined
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    if (!messageId && !streamId && !conversationId) {
      return res.status(400).json({ error: 'messageId, streamId, or conversationId is required' })
    }
    const runs = deps.hookRunRepo.list({ messageId, streamId, conversationId, limit }).map(toSafeHookRunRecord)
    return res.json({ runs })
  })

  app.get('/api/hooks/runs/:id', (req, res) => {
    const run = deps.hookRunRepo?.getById(req.params.id)
    if (!run) return res.status(404).json({ error: 'Hook run not found' })
    return res.json({ run: toSafeHookRunRecord(run) })
  })

  app.post('/api/hooks/run', async (req, res) => {
    const startedAt = Date.now()
    const body = req.body || {}
    const shouldLogHookRun = /^(1|true|yes|on)$/i.test(process.env.YGG_HOOK_DEBUG_LOGS || '')
    if (shouldLogHookRun) {
      console.info('[LocalServer] Hook run request', {
        event: body?.event ?? null,
        conversationId: body?.conversationId ?? null,
        streamId: body?.streamId ?? null,
        operation: body?.operation ?? null,
        cwd: body?.cwd ?? null,
        messageId: body?.messageId ?? null,
        parentId: body?.parentId ?? null,
      })
    }
    try {
      const result = await runHookRequest(body)
      if (shouldLogHookRun || (Array.isArray(result.errors) && result.errors.length > 0)) {
        console.info('[LocalServer] Hook run result', {
          event: body?.event ?? null,
          elapsedMs: Date.now() - startedAt,
          matched: result.matched,
          hookCount: result.hookCount,
          asyncHookCount: result.asyncHookCount ?? 0,
          launchedAsyncHookCount: result.launchedAsyncHookCount ?? 0,
          blocked: result.blocked ?? false,
          hasAdditionalContext: Boolean(result.additionalContext),
          errors: result.errors ?? [],
        })
      }
      res.json(result)
    } catch (error) {
      console.error('[LocalServer] Hook execution error:', error)
      res.status(500).json({
        matched: false,
        hookCount: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      })
    }
  })
}
