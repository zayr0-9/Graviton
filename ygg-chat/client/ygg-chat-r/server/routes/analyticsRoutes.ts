// server/routes/analyticsRoutes.ts
//
// Local analytics APIs. Heavy dashboard aggregation has one worker-backed
// implementation; failures surface rather than falling back to blocking scans.

import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { localAnalyticsWorkerClient } from '../localAnalyticsWorkerClient.js'

export interface AnalyticsRoutesDeps {
  db: Database.Database
  getCurrentDbPath: () => string | null
}

export function registerAnalyticsRoutes(app: Express, deps: AnalyticsRoutesDeps): void {
  const { db } = deps
  const getCurrentDbPath = deps.getCurrentDbPath

  // Stats endpoint
  app.get('/api/sync/stats', (_req, res) => {
    try {
      const stats = {
        projects: db!.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number },
        conversations: db!.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number },
        messages: db!.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number },
        attachments: db!.prepare('SELECT COUNT(*) as count FROM message_attachments').get() as { count: number },
      }
      res.json(stats)
    } catch (error) {
      console.error('[LocalServer] Error getting stats:', error)
      res.status(500).json({ error: 'Failed to get stats' })
    }
  })

  // Local analytics dashboard endpoint
  // Keep expensive better-sqlite3 scans/aggregations in a worker thread instead
  // of blocking the Electron/local server event loop while LoggingPage loads.
  app.get('/api/local/analytics/dashboard', async (req, res) => {
    try {
      const currentDbPath = getCurrentDbPath()
      if (!currentDbPath) {
        res.status(503).json({ error: 'Failed to get local analytics dashboard', message: 'Local database is not initialized' })
        return
      }

      const dashboard = await localAnalyticsWorkerClient.run(currentDbPath, req.query as Record<string, unknown>)
      res.json(dashboard)
    } catch (error) {
      console.error('[LocalServer] Error getting local analytics dashboard:', error)
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: 'Failed to get local analytics dashboard', message })
    }
  })

}
