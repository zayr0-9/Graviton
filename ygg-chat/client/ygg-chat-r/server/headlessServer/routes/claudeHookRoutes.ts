import type { Express } from 'express'
import path from 'node:path'
import { ConversationRepo } from '../persistence/conversationRepo.js'
import { ProjectRepo } from '../persistence/projectRepo.js'
import { readClaudeHookInventory } from '../services/claudeHookInventory.js'

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** Only inspect settings for persisted workspace selections, never a path supplied by the client. */
export function registerClaudeHookRoutes(app: Express, deps: ConstructorParameters<typeof ConversationRepo>[0]): void {
  const conversations = new ConversationRepo(deps)
  const projects = new ProjectRepo(deps)
  app.get('/api/headless/claude/hooks', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const { conversationId, projectId } = req.query
    if ((conversationId !== undefined && !validId(conversationId)) || (projectId !== undefined && !validId(projectId))) {
      res.status(400).json({ error: 'Invalid workspace selection.' })
      return
    }
    try {
      const conversation = validId(conversationId) ? conversations.getById(conversationId) : null
      const effectiveProjectId = conversation?.project_id ?? projectId
      const project = validId(effectiveProjectId) ? projects.getById(effectiveProjectId) : null
      if ((conversationId && !conversation) || (effectiveProjectId && !project)) {
        res.status(404).json({ error: 'The selected workspace no longer exists.' })
        return
      }
      const cwd = conversation?.cwd || project?.cwd
      res.json(await readClaudeHookInventory(typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null))
    } catch {
      res.status(500).json({ error: 'Could not read Claude Code hook declarations.' })
    }
  })
}
