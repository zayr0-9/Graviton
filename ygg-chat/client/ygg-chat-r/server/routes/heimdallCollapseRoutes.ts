// server/routes/heimdallCollapseRoutes.ts
//
// Heimdall collapse groups (visual-only tree management) per conversation:
//   GET /api/local/conversations/:id/heimdall-collapse-groups -> { groups }
//   PUT /api/local/conversations/:id/heimdall-collapse-groups  { groups } -> { groups }
// PUT replaces the whole set; the renderer always sends its complete list.

import type Database from 'better-sqlite3'
import type { Express } from 'express'
import {
  HeimdallCollapseRepo,
  HeimdallCollapseValidationError,
  parseHeimdallCollapseGroups,
} from '../headlessServer/persistence/heimdallCollapseRepo.js'

const ROUTE = '/api/local/conversations/:id/heimdall-collapse-groups'

export function registerHeimdallCollapseRoutes(app: Express, deps: { db: Database.Database }): void {
  const repo = new HeimdallCollapseRepo(deps.db)

  app.get(ROUTE, (req, res) => {
    try {
      const conversationId = String(req.params.id)
      if (!repo.conversationExists(conversationId)) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }
      res.json({ groups: repo.list(conversationId) })
    } catch (error) {
      console.error('[HeimdallCollapse] list failed:', error)
      res.status(500).json({ error: 'Failed to load collapsed nodes' })
    }
  })

  app.put(ROUTE, (req, res) => {
    try {
      const conversationId = String(req.params.id)
      const groups = parseHeimdallCollapseGroups(req.body?.groups)
      if (!repo.conversationExists(conversationId)) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }
      res.json({ groups: repo.replace(conversationId, groups) })
    } catch (error) {
      if (error instanceof HeimdallCollapseValidationError) {
        res.status(400).json({ error: error.message })
        return
      }
      console.error('[HeimdallCollapse] save failed:', error)
      res.status(500).json({ error: 'Failed to save collapsed nodes' })
    }
  })
}
