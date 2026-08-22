import type Database from 'better-sqlite3'
import type { Express } from 'express'

const TOOL_RETENTION_DAYS = 30

const normalizeBool = (value: any) => (value ? 1 : 0)

const getHtmlSizeBytes = (html: string) => {
  try {
    return Buffer.byteLength(html ?? '', 'utf8')
  } catch {
    return typeof html === 'string' ? html.length : 0
  }
}

export const initializeToolsSchema = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS html_tools (
      key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      html TEXT NOT NULL,
      label TEXT,
      tool_name TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('active','hibernated')) DEFAULT 'active',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      conversation_id TEXT,
      project_id TEXT,
      PRIMARY KEY (key, user_id)
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_html_tools_user_id ON html_tools(user_id);
    CREATE INDEX IF NOT EXISTS idx_html_tools_last_used ON html_tools(last_used_at);
    CREATE INDEX IF NOT EXISTS idx_html_tools_updated ON html_tools(updated_at);
    CREATE INDEX IF NOT EXISTS idx_html_tools_favorite ON html_tools(favorite);
  `)

  try {
    const columns = db.prepare(`PRAGMA table_info(html_tools)`).all() as { name: string }[]
    const columnNames = new Set(columns.map(column => column.name))
    if (!columnNames.has('tool_name')) {
      db.exec(`ALTER TABLE html_tools ADD COLUMN tool_name TEXT`)
    }
  } catch (error) {
    console.warn('[LocalServer] Failed to migrate html_tools table:', error)
  }
}

export const createToolsStatements = (db: Database.Database) => ({
  upsertTool: db.prepare(`
    INSERT INTO html_tools (
      key,
      user_id,
      html,
      label,
      tool_name,
      favorite,
      status,
      size_bytes,
      created_at,
      updated_at,
      last_used_at,
      conversation_id,
      project_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key, user_id) DO UPDATE SET
      html = excluded.html,
      label = excluded.label,
      tool_name = excluded.tool_name,
      favorite = excluded.favorite,
      status = excluded.status,
      size_bytes = excluded.size_bytes,
      updated_at = excluded.updated_at,
      last_used_at = excluded.last_used_at,
      conversation_id = excluded.conversation_id,
      project_id = excluded.project_id
  `),
  deleteTool: db.prepare('DELETE FROM html_tools WHERE key = ? AND user_id = ?'),
  getToolByKey: db.prepare('SELECT * FROM html_tools WHERE key = ? AND user_id = ?'),
  getToolsByUserId: db.prepare('SELECT * FROM html_tools WHERE user_id = ? ORDER BY last_used_at DESC'),
  getActiveToolsByUserId: db.prepare(
    "SELECT * FROM html_tools WHERE user_id = ? AND status = 'active' ORDER BY last_used_at DESC"
  ),
  deleteToolsBeforeTimestamp: db.prepare('DELETE FROM html_tools WHERE last_used_at < ?'),
})

export const pruneOldTools = (statements: any) => {
  if (!statements?.deleteToolsBeforeTimestamp) return
  const cutoff = Date.now() - TOOL_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const result = statements.deleteToolsBeforeTimestamp.run(cutoff)
  if (result?.changes) {
    console.log(`[LocalServer] Pruned ${result.changes} html_tools older than ${TOOL_RETENTION_DAYS} days`)
  }
}

export const registerToolsRoutes = (app: Express, db: Database.Database, statements: any) => {
  if (!db) {
    console.error('[LocalServer] Database not initialized for tools routes')
    return
  }

  app.get('/api/local/tools', (req, res) => {
    try {
      const userId = req.query.userId as string
      const includeHibernated = req.query.includeHibernated !== 'false'
      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      const rows = includeHibernated
        ? statements.getToolsByUserId.all(userId)
        : statements.getActiveToolsByUserId.all(userId)
      res.json(rows)
    } catch (error) {
      console.error('[LocalServer] Error fetching html tools:', error)
      res.status(500).json({ error: 'Failed to fetch html tools' })
    }
  })

  app.post('/api/local/tools', (req, res) => {
    try {
      const {
        key,
        userId,
        html,
        label,
        toolName,
        favorite,
        status,
        sizeBytes,
        createdAt,
        updatedAt,
        lastUsedAt,
        conversationId,
        projectId,
      } = req.body || {}

      if (!userId || !key || typeof html !== 'string') {
        res.status(400).json({ error: 'userId, key, and html required' })
        return
      }

      const now = Date.now()
      const record = {
        key,
        user_id: userId,
        html,
        label: label ?? null,
        tool_name: toolName ?? null,
        favorite: normalizeBool(favorite),
        status: status === 'hibernated' ? 'hibernated' : 'active',
        size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : getHtmlSizeBytes(html),
        created_at: Number.isFinite(createdAt) ? createdAt : now,
        updated_at: Number.isFinite(updatedAt) ? updatedAt : now,
        last_used_at: Number.isFinite(lastUsedAt) ? lastUsedAt : now,
        conversation_id: conversationId ?? null,
        project_id: projectId ?? null,
      }

      statements.upsertTool.run(
        record.key,
        record.user_id,
        record.html,
        record.label,
        record.tool_name,
        record.favorite,
        record.status,
        record.size_bytes,
        record.created_at,
        record.updated_at,
        record.last_used_at,
        record.conversation_id,
        record.project_id
      )

      const saved = statements.getToolByKey.get(record.key, record.user_id)
      res.json(saved)
    } catch (error) {
      console.error('[LocalServer] Error upserting html tool:', error)
      res.status(500).json({ error: 'Failed to save html tool' })
    }
  })

  app.post('/api/local/tools/bulk', (req, res) => {
    try {
      const { userId, tools } = req.body || {}
      if (!userId || !Array.isArray(tools)) {
        res.status(400).json({ error: 'userId and tools array required' })
        return
      }

      const now = Date.now()
      const upsertMany = db.transaction((items: any[]) => {
        items.forEach(item => {
          if (!item?.key || typeof item?.html !== 'string') return
          const record = {
            key: item.key,
            user_id: userId,
            html: item.html,
            label: item.label ?? null,
            tool_name: item.toolName ?? null,
            favorite: normalizeBool(item.favorite),
            status: item.status === 'hibernated' ? 'hibernated' : 'active',
            size_bytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : getHtmlSizeBytes(item.html),
            created_at: Number.isFinite(item.createdAt) ? item.createdAt : now,
            updated_at: Number.isFinite(item.updatedAt) ? item.updatedAt : now,
            last_used_at: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : now,
            conversation_id: item.conversationId ?? null,
            project_id: item.projectId ?? null,
          }
          statements.upsertTool.run(
            record.key,
            record.user_id,
            record.html,
            record.label,
            record.tool_name,
            record.favorite,
            record.status,
            record.size_bytes,
            record.created_at,
            record.updated_at,
            record.last_used_at,
            record.conversation_id,
            record.project_id
          )
        })
      })

      upsertMany(tools)
      res.json({ success: true, count: tools.length })
    } catch (error) {
      console.error('[LocalServer] Error bulk upserting html tools:', error)
      res.status(500).json({ error: 'Failed to save html tools' })
    }
  })

  app.patch('/api/local/tools/:key', (req, res) => {
    try {
      const rawKey = req.params.key
      const key = decodeURIComponent(rawKey)
      const {
        userId,
        html,
        label,
        toolName,
        favorite,
        status,
        sizeBytes,
        updatedAt,
        lastUsedAt,
        conversationId,
        projectId,
      } = req.body || {}

      if (!userId || !key) {
        res.status(400).json({ error: 'userId and key required' })
        return
      }

      const updates: string[] = []
      const values: any[] = []

      if (html !== undefined) {
        updates.push('html = ?')
        values.push(html)
        updates.push('size_bytes = ?')
        values.push(Number.isFinite(sizeBytes) ? sizeBytes : getHtmlSizeBytes(html))
      } else if (sizeBytes !== undefined) {
        updates.push('size_bytes = ?')
        values.push(sizeBytes)
      }

      if (toolName !== undefined) {
        updates.push('tool_name = ?')
        values.push(toolName)
      }

      if (label !== undefined) {
        updates.push('label = ?')
        values.push(label)
      }

      if (favorite !== undefined) {
        updates.push('favorite = ?')
        values.push(normalizeBool(favorite))
      }

      if (status !== undefined) {
        updates.push('status = ?')
        values.push(status === 'hibernated' ? 'hibernated' : 'active')
      }

      if (lastUsedAt !== undefined) {
        updates.push('last_used_at = ?')
        values.push(lastUsedAt)
      }

      if (conversationId !== undefined) {
        updates.push('conversation_id = ?')
        values.push(conversationId)
      }

      if (projectId !== undefined) {
        updates.push('project_id = ?')
        values.push(projectId)
      }

      updates.push('updated_at = ?')
      values.push(Number.isFinite(updatedAt) ? updatedAt : Date.now())

      if (updates.length === 0) {
        const existing = statements.getToolByKey.get(key, userId)
        res.json(existing)
        return
      }

      const sql = `UPDATE html_tools SET ${updates.join(', ')} WHERE key = ? AND user_id = ?`
      values.push(key, userId)
      db.prepare(sql).run(...values)

      const updated = statements.getToolByKey.get(key, userId)
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating html tool:', error)
      res.status(500).json({ error: 'Failed to update html tool' })
    }
  })

  app.delete('/api/local/tools/:key', (req, res) => {
    try {
      const rawKey = req.params.key
      const key = decodeURIComponent(rawKey)
      const userId = req.query.userId as string
      if (!userId || !key) {
        res.status(400).json({ error: 'userId and key required' })
        return
      }
      statements.deleteTool.run(key, userId)
      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] Error deleting html tool:', error)
      res.status(500).json({ error: 'Failed to delete html tool' })
    }
  })
}
