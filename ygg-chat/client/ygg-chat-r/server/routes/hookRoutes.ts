// server/routes/hookRoutes.ts
//
// Managed-hook APIs (/api/hooks, /api/hooks/toggle, /api/hooks/run),
// extracted verbatim from localServer.ts setupServer().

import type { Express } from 'express'
import { listManagedHooks, setManagedHookEnabled } from '../hooks/hookManager.js'
import { runHookRequest } from '../hooks/hookRunner.js'

export function registerHookRoutes(app: Express): void {
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
