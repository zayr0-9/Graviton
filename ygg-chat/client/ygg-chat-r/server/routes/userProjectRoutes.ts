// server/routes/userProjectRoutes.ts
//
// Conversation metadata patches (/api/conversations/:id/research-note,
// /cwd, /project), local user APIs (/api/local/users*), and local
// project APIs (/api/local/projects*, /api/projects/:id/touch),
// extracted verbatim from localServer.ts setupServer().

import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { v4 as uuidv4 } from 'uuid'

export interface UserProjectRoutesDeps {
  db: Database.Database
  statements: any
}

export function registerUserProjectRoutes(app: Express, deps: UserProjectRoutesDeps): void {
  const { db, statements } = deps

  // Update conversation research note
  app.patch('/api/conversations/:id/research-note', (req, res) => {
    try {
      const { id } = req.params
      const { researchNote } = req.body

      const normalizedResearchNote =
        typeof researchNote === 'string' && researchNote.trim().length === 0 ? null : (researchNote as string | null)

      statements.updateConversationResearchNote.run(normalizedResearchNote, id)
      const updated = statements.getConversationById.get(id)

      if (updated) {
        res.json(updated)
      } else {
        res.status(404).json({ error: 'Conversation not found' })
      }
    } catch (error) {
      console.error('[LocalServer] Error updating research note:', error)
      res.status(500).json({ error: 'Failed to update research note' })
    }
  })

  // Update conversation cwd
  app.patch('/api/conversations/:id/cwd', (req, res) => {
    try {
      const { id } = req.params
      const { cwd } = req.body

      const normalizedCwd = typeof cwd === 'string' && cwd.trim().length === 0 ? null : (cwd as string | null)

      statements.updateConversationCwd.run(normalizedCwd, id)
      const updated = statements.getConversationById.get(id)

      if (updated) {
        res.json(updated)
      } else {
        res.status(404).json({ error: 'Conversation not found' })
      }
    } catch (error) {
      console.error('[LocalServer] Error updating cwd:', error)
      res.status(500).json({ error: 'Failed to update cwd' })
    }
  })

  // Update conversation project
  app.patch('/api/conversations/:id/project', (req, res) => {
    try {
      const { id } = req.params
      const { projectId } = req.body

      // Require projectId to be explicitly provided (can be null to unassign, but must be present)
      if (!('projectId' in req.body)) {
        res.status(400).json({ error: 'projectId is required in request body' })
        return
      }

      // projectId can be null (unassign from project) or a valid project UUID string
      if (projectId !== null && typeof projectId !== 'string') {
        res.status(400).json({ error: 'projectId must be a string or null' })
        return
      }

      const existing = statements.getConversationById.get(id)
      if (!existing) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      // If projectId is provided (not null), verify the project exists
      if (projectId !== null) {
        const project = statements.getProjectById.get(projectId)
        if (!project) {
          res.status(404).json({ error: 'Destination project not found' })
          return
        }
      }

      statements.updateConversationProjectId.run(projectId, id)
      const updated = statements.getConversationById.get(id)

      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating project:', error)
      res.status(500).json({ error: 'Failed to update project' })
    }
  })

  // List local users available for manual ownership migration
  app.get('/api/local/users', (_req, res) => {
    try {
      const users = db!
        .prepare(
          `SELECT
             u.id,
             u.username,
             u.created_at,
             (SELECT COUNT(*) FROM projects p WHERE p.user_id = u.id) AS project_count,
             (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversation_count,
             (SELECT COUNT(*) FROM provider_cost pc WHERE pc.user_id = u.id) AS provider_cost_count
           FROM users u
           ORDER BY conversation_count DESC, project_count DESC, created_at DESC`
        )
        .all()

      res.json(users)
    } catch (error) {
      console.error('[LocalServer] Error listing local users:', error)
      res.status(500).json({ error: 'Failed to list local users' })
    }
  })

  // Merge local-only user data into a cloud-authenticated user account
  app.post('/api/local/users/merge', (req, res) => {
    try {
      const { fromUserId, toUserId, toUsername, toCreatedAt } = req.body as {
        fromUserId?: string
        toUserId?: string
        toUsername?: string
        toCreatedAt?: string
      }

      if (!fromUserId || !toUserId) {
        res.status(400).json({ error: 'fromUserId and toUserId are required' })
        return
      }

      if (fromUserId === toUserId) {
        res.json({ success: true, merged: false, message: 'Source and target user are the same' })
        return
      }

      // Strict safety rule: only allow migration when there are NO existing non-default users.
      // If any cloud user already exists locally, do not re-parent default-local data.
      const existingNonDefaultUsers = db!
        .prepare('SELECT COUNT(*) as count FROM users WHERE id != ?')
        .get(fromUserId) as { count: number }

      if ((existingNonDefaultUsers?.count || 0) > 0) {
        res.json({
          success: true,
          merged: false,
          reason: 'existing_cloud_user_present',
          message: 'Migration skipped because a non-default user already exists locally',
        })
        return
      }

      const mergeTx = db!.transaction(() => {
        const toUserExists = db!.prepare('SELECT id FROM users WHERE id = ?').get(toUserId)
        if (!toUserExists) {
          db!
            .prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)')
            .run(toUserId, toUsername || 'user', toCreatedAt || new Date().toISOString())
        }

        const projectsResult = db!
          .prepare('UPDATE projects SET user_id = ? WHERE user_id = ?')
          .run(toUserId, fromUserId)
        const conversationsResult = db!
          .prepare('UPDATE conversations SET user_id = ? WHERE user_id = ?')
          .run(toUserId, fromUserId)
        const providerCostResult = db!
          .prepare('UPDATE provider_cost SET user_id = ? WHERE user_id = ?')
          .run(toUserId, fromUserId)

        const remainingRefs = db!
          .prepare(
            `SELECT (
              (SELECT COUNT(*) FROM projects WHERE user_id = ?) +
              (SELECT COUNT(*) FROM conversations WHERE user_id = ?) +
              (SELECT COUNT(*) FROM provider_cost WHERE user_id = ?)
            ) as total`
          )
          .get(fromUserId, fromUserId, fromUserId) as { total: number }

        if ((remainingRefs?.total || 0) === 0) {
          db!.prepare('DELETE FROM users WHERE id = ?').run(fromUserId)
        }

        return {
          projects: projectsResult.changes,
          conversations: conversationsResult.changes,
          providerCosts: providerCostResult.changes,
        }
      })()

      res.json({ success: true, merged: true, ...mergeTx })
    } catch (error) {
      console.error('[LocalServer] Error merging local user data:', error)
      res.status(500).json({ error: 'Failed to merge local user data' })
    }
  })

  // Local-only API endpoints
  app.get('/api/local/projects', (req, res) => {
    try {
      const userId = (req.query.userId as string) || ''
      if (!userId) {
        res.status(400).json({ error: 'userId query param required' })
        return
      }
      const projects = statements.getLocalProjects.all(userId)
      res.json(projects)
    } catch (error) {
      console.error('[LocalServer] Error fetching local projects:', error)
      res.status(500).json({ error: 'Failed to fetch local projects' })
    }
  })

  app.post('/api/local/projects', (req, res) => {
    try {
      const { id, name, user_id, context, system_prompt, cwd } = req.body
      if (!user_id) {
        res.status(400).json({ error: 'user_id required' })
        return
      }
      const projectId = id || uuidv4()
      const now = new Date().toISOString()
      statements.upsertProject.run(
        projectId,
        name || 'Untitled Project',
        user_id,
        context || null,
        system_prompt || null,
        cwd || null,
        'local',
        now,
        now
      )
      res.status(201).json(statements.getProjectById.get(projectId))
    } catch (error) {
      console.error('[LocalServer] Error creating local project:', error)
      res.status(500).json({ error: 'Failed to create local project' })
    }
  })

  // GET /api/local/projects/:id
  app.get('/api/local/projects/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] GET /api/local/projects/:id - projectId:', id)
      const project = statements.getProjectById.get(id)

      if (!project) {
        // console.log('[LocalServer] Project not found:', id)
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Verify it's actually a local project
      if (project.storage_mode !== 'local') {
        // console.log('[LocalServer] Project is not local storage:', id)
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // console.log('[LocalServer] Found local project:', id)
      res.json(project)
    } catch (error) {
      console.error('[LocalServer] Error fetching local project:', error)
      res.status(500).json({ error: 'Failed to fetch project' })
    }
  })

  // PATCH /api/local/projects/:id
  app.patch('/api/local/projects/:id', (req, res) => {
    try {
      const { id } = req.params
      const { name, context, system_prompt, cwd } = req.body

      const existing = statements.getProjectById.get(id) as any
      if (!existing) {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Verify it's actually a local project
      if (existing.storage_mode !== 'local') {
        res.status(404).json({ error: 'Project not found' })
        return
      }

      // Update only provided fields
      db!
        .prepare(
          `
        UPDATE projects SET 
          name = COALESCE(?, name),
          context = ?,
          system_prompt = ?,
          cwd = ?,
          updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `
        )
        .run(
          name || existing.name,
          context !== undefined ? context : existing.context,
          system_prompt !== undefined ? system_prompt : existing.system_prompt,
          cwd !== undefined ? cwd : existing.cwd,
          id
        )

      const updated = statements.getProjectById.get(id)
      // console.log('[LocalServer] Updated local project:', id)
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating local project:', error)
      res.status(500).json({ error: 'Failed to update project' })
    }
  })

  // PATCH /api/projects/:id/touch - Update project updated_at timestamp (for any project)
  // Called when a message is added to a conversation belonging to this project
  app.patch('/api/projects/:id/touch', (req, res) => {
    try {
      const { id } = req.params

      const existing = statements.getProjectById.get(id) as any
      if (!existing) {
        // Project doesn't exist locally - this is fine for cloud-only projects
        res.json({ success: true, id, touched: false, reason: 'project_not_found_locally' })
        return
      }

      // Update only the updated_at timestamp
      db!
        .prepare(
          `
        UPDATE projects SET
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
        )
        .run(id)

      // console.log('[LocalServer] Touched project timestamp:', id)
      res.json({ success: true, id, touched: true })
    } catch (error) {
      console.error('[LocalServer] Error touching project timestamp:', error)
      res.status(500).json({ error: 'Failed to touch project timestamp' })
    }
  })
}
