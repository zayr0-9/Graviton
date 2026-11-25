import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { LineageRepo } from '../persistence/lineageRepo.js'
import { TranscriptRevisionRepo } from '../persistence/transcriptRevisionRepo.js'

/** Apply lives exclusively in the main-chat approval handler. The UI can read and undo. */
export function registerTranscriptRevisionRoutes(app: Express, deps: { db: Database.Database; statements: any }): void {
  const lineages = new LineageRepo(deps)
  const revisions = new TranscriptRevisionRepo(deps.db)
  const path = '/api/gw/conversations/:conversationId/lineages/:lineageId/transcript-revisions'
  const ownsLineage = (conversationId: string, lineageId: string) =>
    lineages.get(lineageId)?.conversation_id === conversationId

  app.get(path, (req, res) => {
    const { conversationId, lineageId } = req.params
    if (!ownsLineage(conversationId, lineageId)) { res.status(404).json({ error: 'Lineage not found' }); return }
    res.json(revisions.list(lineageId))
  })

  app.post(`${path}/:messageId/undo`, (req, res) => {
    const { conversationId, lineageId, messageId } = req.params
    const id = req.body?.revisionId
    if (!ownsLineage(conversationId, lineageId)) { res.status(404).json({ error: 'Lineage not found' }); return }
    if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: 'A valid revision id is required' }); return }
    try {
      revisions.undo(conversationId, lineageId, messageId, id)
      res.json({ success: true })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : 'Could not undo the revision' })
    }
  })
}
