// server/routes/undoRoutes.ts
//
// Stream edit undo APIs (/api/undo/*), extracted verbatim from
// localServer.ts setupServer().

import type { Express } from 'express'
import {
  getStreamUndoSummary,
  listStreamUndoSummariesByConversation,
  markStreamUndoAssistantMessage,
  restoreStreamUndo,
} from '../tools/streamUndoManager.js'

export function registerUndoRoutes(app: Express): void {
  // Stream edit undo endpoints
  app.get('/api/undo/streams/:streamId', async (req, res) => {
    try {
      const summary = await getStreamUndoSummary(req.params.streamId)
      if (!summary) {
        res.status(404).json({ success: false, error: 'Undo manifest not found' })
        return
      }
      res.json({ success: true, summary })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  app.get('/api/undo/conversations/:conversationId', async (req, res) => {
    try {
      const summaries = await listStreamUndoSummariesByConversation(req.params.conversationId)
      res.json({ success: true, summaries })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  app.post('/api/undo/streams/:streamId/final-message', async (req, res) => {
    try {
      const summary = await markStreamUndoAssistantMessage(
        req.params.streamId,
        typeof req.body?.assistantMessageId === 'string' ? req.body.assistantMessageId : null
      )
      res.json({ success: true, summary })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  app.post('/api/undo/streams/:streamId/restore', async (req, res) => {
    try {
      const result = await restoreStreamUndo(req.params.streamId, {
        force: req.body?.force === true,
        expectedParentMessageId:
          typeof req.body?.expectedParentMessageId === 'string' ? req.body.expectedParentMessageId : null,
        restoredByMessageId: typeof req.body?.restoredByMessageId === 'string' ? req.body.restoredByMessageId : null,
      })
      res.status(result.success ? 200 : result.conflicts.length > 0 ? 409 : 400).json(result)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })
}
