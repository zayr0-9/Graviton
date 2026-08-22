import type Database from 'better-sqlite3'
import type { Express, Request, Response } from 'express'
import { LineageRepo } from '../persistence/lineageRepo.js'

interface LineageRouteRepo {
  reconcileLegacyConversation(conversationId: string): unknown
  list(conversationId: string): unknown[]
  getDetail(conversationId: string, lineageId: string): unknown | null
  listRecent(projectId: string, limit: number, userId?: string | null): unknown[]
}

interface RegisterLineageRoutesDeps {
  db: Database.Database
  statements: any
  repo?: LineageRouteRepo
}

const requestedUserId = (req: Request): string | null => {
  const value = req.query.userId ?? req.query.user_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const owns = (row: any, userId: string | null): boolean => !userId || !row?.user_id || row.user_id === userId

const sendError = (res: Response, status: number, error: string): void => {
  res.status(status).json({ error })
}

/** Electron-local lineage reads. Cloud routing deliberately does not participate. */
export function registerLineageRoutes(app: Express, deps: RegisterLineageRoutesDeps): void {
  const repo: LineageRouteRepo = deps.repo ?? new LineageRepo(deps)

  app.get('/api/gw/conversations/:conversationId/lineages', (req, res) => {
    const conversation = deps.statements.getConversationById?.get(req.params.conversationId)
    if (!conversation) return sendError(res, 404, 'Conversation not found')
    if (!owns(conversation, requestedUserId(req))) return sendError(res, 404, 'Conversation not found')

    repo.reconcileLegacyConversation(req.params.conversationId)
    res.json(repo.list(req.params.conversationId))
  })

  app.get('/api/gw/conversations/:conversationId/lineages/:lineageId', (req, res) => {
    const conversation = deps.statements.getConversationById?.get(req.params.conversationId)
    if (!conversation) return sendError(res, 404, 'Conversation not found')
    if (!owns(conversation, requestedUserId(req))) return sendError(res, 404, 'Conversation not found')

    repo.reconcileLegacyConversation(req.params.conversationId)
    const detail = repo.getDetail(req.params.conversationId, req.params.lineageId)
    if (!detail) return sendError(res, 404, 'Lineage not found')
    res.json(detail)
  })

  app.get('/api/gw/projects/:projectId/recent-lineages', (req, res) => {
    const project = deps.statements.getProjectById?.get(req.params.projectId)
    if (!project) return sendError(res, 404, 'Project not found')
    const userId = requestedUserId(req)
    if (!owns(project, userId)) return sendError(res, 404, 'Project not found')

    const parsed = Number.parseInt(String(req.query.limit ?? '20'), 10)
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 100)) : 20
    res.json(repo.listRecent(req.params.projectId, limit, userId))
  })
}
