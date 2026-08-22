// server/routes/syncStorageRoutes.ts
//
// Local storage sync APIs, extracted verbatim from localServer.ts
// setupServer(): /api/sync/* (user, project, conversation, message,
// attachment, provider-cost, batch) and the local attachment binary
// endpoints /api/local/attachments/*. Includes the ensure*Exists sync
// helpers and generated-image persistence used only by these routes.
//
// deps.db/statements come from initializeLocalDatabase(); registration
// happens after DB init. getCurrentDbPath() stays a getter because the
// attachment/image directories are resolved next to the live DB file.

import type Database from 'better-sqlite3'
import crypto from 'crypto'
import type { Express } from 'express'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

export interface SyncStorageRoutesDeps {
  db: Database.Database
  statements: any
  getCurrentDbPath: () => string | null
}

export function registerSyncStorageRoutes(app: Express, deps: SyncStorageRoutesDeps): void {
  const { db, statements } = deps
  const getCurrentDbPath = deps.getCurrentDbPath

  // Helper functions to ensure dependencies exist before sync operations
  function ensureUserExists(userId: string) {
    if (!db) return
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
    if (!existing) {
      // console.log('[LocalServer] Auto-creating user stub:', userId)
      db.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run(
        userId,
        `synced-user-${userId.substring(0, 8)}`,
        new Date().toISOString()
      )
    }
  }

  function ensureProjectExists(projectId: string, userId: string) {
    if (!db) return
    ensureUserExists(userId) // Project requires user to exist
    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!existing) {
      // console.log('[LocalServer] Auto-creating project stub:', projectId)
      const now = new Date().toISOString()
      db.prepare(
        'INSERT INTO projects (id, name, user_id, context, system_prompt, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'Synced Project', userId, null, null, null, now, now)
    }
  }

  function ensureConversationExists(conversationId: string, userId: string, projectId?: string | null) {
    if (!db) return
    ensureUserExists(userId) // Conversation requires user to exist
    if (projectId) {
      ensureProjectExists(projectId, userId) // If project is set, ensure it exists
    }
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)
    if (!existing) {
      // console.log('[LocalServer] Auto-creating conversation stub:', conversationId)
      const now = new Date().toISOString()
      db.prepare(
        'INSERT INTO conversations (id, project_id, user_id, title, model_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(conversationId, projectId || null, userId, 'Synced Conversation', 'unknown', now, now)
    }
  }

  // Helper to save generated images from image-generating models to local storage
  function getGeneratedImageExtension(mimeType: string): string {
    const normalized = (mimeType || 'image/png').toLowerCase().split(';')[0].trim()
    if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg'
    if (normalized === 'image/svg+xml') return 'svg'
    return normalized.startsWith('image/') ? normalized.slice('image/'.length) || 'png' : 'png'
  }

  function createGeneratedImageShortId(): string {
    if (!db) return `img-${Date.now()}`
    const row = db.prepare(`
      SELECT short_id FROM message_attachments
      WHERE short_id LIKE 'img-%'
      ORDER BY CAST(substr(short_id, 5) AS INTEGER) DESC
      LIMIT 1
    `).get() as { short_id?: string | null } | undefined
    const last = typeof row?.short_id === 'string' ? Number.parseInt(row.short_id.replace(/^img-/, ''), 10) : 0
    const next = Number.isFinite(last) ? last + 1 : 1
    return `img-${String(next).padStart(4, '0')}`
  }

  function incrementGeneratedImageShortId(shortId: string): string {
    const match = /^img-(\d+)$/.exec(shortId)
    if (!match) return `img-${Date.now()}`
    const width = match[1].length || 4
    const next = Number.parseInt(match[1], 10) + 1
    return `img-${String(next).padStart(width, '0')}`
  }

  function extractGeneratedImageFilePathsFromContentBlocks(contentBlocks: any): string[] {
    const parsed = typeof contentBlocks === 'string' ? (() => {
      try { return JSON.parse(contentBlocks) } catch { return [] }
    })() : contentBlocks
    if (!Array.isArray(parsed)) return []

    const paths: string[] = []
    for (const block of parsed) {
      if (!block || typeof block !== 'object') continue
      const candidate = typeof block.filePath === 'string' ? block.filePath : typeof block.file_path === 'string' ? block.file_path : null
      if (candidate && block.type === 'image') paths.push(candidate)
    }
    return Array.from(new Set(paths))
  }

  async function saveGeneratedImage(
    messageId: string,
    imageUrl: string,
    mimeType: string = 'image/png'
  ): Promise<{ filePath: string; attachmentId: string } | null> {
    const currentDbPath = getCurrentDbPath()
    if (!db || !statements || !currentDbPath) {
      console.error('[LocalServer] Database not initialized for saving generated image')
      return null
    }

    try {
      console.log('[LocalServer] Saving generated image', {
        messageId,
        mimeType,
        sourceType: imageUrl.startsWith('data:') ? 'data-url' : 'url',
        sourceLength: imageUrl.length,
      })
      let buffer: Buffer
      if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
        const commaIndex = imageUrl.indexOf(',')
        if (commaIndex < 0) {
          console.error('[LocalServer] Invalid generated image data URL')
          return null
        }
        const header = imageUrl.slice(0, commaIndex)
        const payload = imageUrl.slice(commaIndex + 1)
        buffer = header.includes(';base64')
          ? Buffer.from(payload, 'base64')
          : Buffer.from(decodeURIComponent(payload), 'utf8')
      } else {
        // Download the image
        const response = await fetch(imageUrl)
        if (!response.ok) {
          console.error('[LocalServer] Failed to download image:', imageUrl, response.statusText)
          return null
        }

        buffer = Buffer.from(await response.arrayBuffer())
      }

      // Calculate SHA256 for deduplication
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')

      const now = new Date().toISOString()

      // Check if attachment with this sha256 already exists (deduplication)
      const existingAttachment = statements.getAttachmentBySha256.get(sha256) as
        | { id: string; file_path: string; short_id?: string | null }
        | undefined

      const ext = getGeneratedImageExtension(mimeType)
      const imagesDir = path.join(path.dirname(currentDbPath), 'generated_images')

      // Ensure directory exists
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true })
      }

      let attachmentId: string
      let shortId = typeof existingAttachment?.short_id === 'string' && existingAttachment.short_id.trim()
        ? existingAttachment.short_id.trim()
        : createGeneratedImageShortId()
      let filePath = path.join(imagesDir, `${shortId}.${ext}`)

      if (existingAttachment) {
        // Reuse existing attachment metadata, but prefer the short generated-image path.
        attachmentId = existingAttachment.id
        if (typeof existingAttachment.file_path === 'string' && existingAttachment.file_path.trim()) {
          filePath = existingAttachment.file_path
        }
      } else {
        while (fs.existsSync(filePath)) {
          shortId = incrementGeneratedImageShortId(shortId)
          filePath = path.join(imagesDir, `${shortId}.${ext}`)
        }
        fs.writeFileSync(filePath, buffer)

        // Create new attachment record
        attachmentId = uuidv4()
        statements.upsertAttachment.run(
          attachmentId,
          messageId,
          'image',
          mimeType,
          'file',
          null, // url
          filePath,
          null, // width
          null, // height
          buffer.length,
          sha256,
          now,
          shortId
        )
      }

      // Link attachment to message (INSERT OR IGNORE handles duplicate links gracefully)
      statements.linkAttachment.run(uuidv4(), messageId, attachmentId, now)

      try {
        const messageRow = db.prepare('SELECT content_blocks FROM messages WHERE id = ?').get(messageId) as { content_blocks?: string | null } | undefined
        const blocks = messageRow?.content_blocks ? JSON.parse(messageRow.content_blocks) : []
        if (Array.isArray(blocks)) {
          let changed = false
          const updatedBlocks = blocks.map((block: any) => {
            if (block?.type === 'image' && typeof block.url === 'string' && block.url === imageUrl) {
              changed = true
              return { ...block, filePath, file_path: filePath, attachmentId, attachment_id: attachmentId, shortId, short_id: shortId, sha256 }
            }
            return block
          })
          if (changed) {
            db.prepare('UPDATE messages SET content_blocks = ? WHERE id = ?').run(JSON.stringify(updatedBlocks), messageId)
          }
        }
      } catch (metadataError) {
        console.warn('[LocalServer] Failed to annotate generated image content block with file path:', metadataError)
      }

      return { filePath, attachmentId }
    } catch (error) {
      console.error('[LocalServer] Error saving generated image:', error)
      return null
    }
  }

  // Sync User
  app.post('/api/sync/user', (req, res) => {
    try {
      const { id, username, created_at } = req.body
      statements.upsertUser.run(id, username, created_at || new Date().toISOString())
      // console.log('[LocalServer] Synced user:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error syncing user:', error)
      res.status(500).json({ error: 'Failed to sync user' })
    }
  })

  // Sync Project
  app.post('/api/sync/project', (req, res) => {
    try {
      const { id, name, user_id, owner_id, context, system_prompt, cwd, storage_mode, created_at, updated_at } = req.body

      // Handle owner_id -> user_id mapping (Railway sends owner_id)
      const effectiveUserId = user_id || owner_id
      if (!effectiveUserId) {
        res.status(400).json({ error: 'Missing user_id or owner_id' })
        return
      }

      // Ensure user exists before upserting project
      ensureUserExists(effectiveUserId)

      statements.upsertProject.run(
        id,
        name,
        effectiveUserId,
        context || null,
        system_prompt || null,
        cwd || null,
        storage_mode || 'cloud',
        created_at || new Date().toISOString(),
        updated_at || new Date().toISOString()
      )
      // console.log('[LocalServer] Synced project:', id, '- storage_mode:', storage_mode || 'cloud')
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error syncing project:', error)
      res.status(500).json({ error: 'Failed to sync project' })
    }
  })

  app.delete('/api/sync/project/:id', (req, res) => {
    try {
      const { id } = req.params
      statements.deleteProject.run(id)
      // console.log('[LocalServer] Deleted project:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error deleting project:', error)
      res.status(500).json({ error: 'Failed to delete project' })
    }
  })

  // Get Project (for checking existence)
  app.get('/api/sync/project/:id', (req, res) => {
    try {
      const { id } = req.params
      const project = statements.getProjectById.get(id)
      if (project) {
        res.json({ exists: true, project })
      } else {
        res.json({ exists: false })
      }
    } catch (error) {
      console.error('[LocalServer] Error getting project:', error)
      res.status(500).json({ error: 'Failed to get project' })
    }
  })

  // Sync Conversation
  app.post('/api/sync/conversation', (req, res) => {
    try {
      const {
        id,
        project_id,
        user_id,
        owner_id, // Railway uses owner_id, local uses user_id
        title,
        model_name,
        system_prompt,
        conversation_context,
        research_note,
        cwd,
        storage_mode,
        created_at,
        updated_at,
      } = req.body

      // console.log(
      //   '[LocalServer] 🔄 POST /api/sync/conversation - conversationId:',
      //   id,
      //   'title:',
      //   title,
      //   'storage_mode:',
      //   storage_mode
      // )

      // Handle owner_id -> user_id mapping (Railway sends owner_id)
      const effectiveUserId = user_id || owner_id
      if (!effectiveUserId) {
        // console.log('[LocalServer] ❌ Missing user_id or owner_id')
        res.status(400).json({ error: 'Missing user_id or owner_id' })
        return
      }

      // console.log('[LocalServer] 👤 Effective userId:', effectiveUserId, 'projectId:', project_id)

      // Ensure dependencies exist before upserting conversation
      ensureUserExists(effectiveUserId)
      if (project_id) {
        ensureProjectExists(project_id, effectiveUserId)
      }

      statements.upsertConversation.run(
        id,
        project_id || null,
        effectiveUserId,
        title || null,
        model_name || 'unknown',
        system_prompt || null,
        conversation_context || null,
        research_note || null,
        cwd || null,
        storage_mode || 'cloud',
        created_at || new Date().toISOString(),
        updated_at || new Date().toISOString()
      )
      // console.log('[LocalServer] ✅ Synced conversation successfully:', id, '- title:', title)

      // Verify the conversation was saved
      // const saved = statements.getConversationById.get(id)
      // if (saved) {
      //   console.log(
      //     '[LocalServer] ✅ Verified conversation exists in DB:',
      //     id,
      //     '- storage_mode:',
      //     (saved as any).storage_mode
      //   )
      // } else {
      //   console.log('[LocalServer] ⚠️  Warning: Conversation not found after save:', id)
      // }

      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] ❌ Error syncing conversation:', error)
      res.status(500).json({ error: 'Failed to sync conversation' })
    }
  })

  app.delete('/api/sync/conversation/:id', (req, res) => {
    try {
      const { id } = req.params
      statements.deleteConversation.run(id)
      // console.log('[LocalServer] Deleted conversation:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error deleting conversation:', error)
      res.status(500).json({ error: 'Failed to delete conversation' })
    }
  })

  // Get Conversation (for checking existence)
  app.get('/api/sync/conversation/:id', (req, res) => {
    try {
      const { id } = req.params
      const conversation = statements.getConversationById.get(id)
      if (conversation) {
        res.json({ exists: true, conversation })
      } else {
        res.json({ exists: false })
      }
    } catch (error) {
      console.error('[LocalServer] Error getting conversation:', error)
      res.status(500).json({ error: 'Failed to get conversation' })
    }
  })

  // Sync Message
  app.post('/api/sync/message', async (req, res) => {
    try {
      const {
        id,
        conversation_id,
        parent_id,
        children_ids,
        role,
        content,
        plain_text_content,
        thinking_block,
        tool_calls,
        tool_call_id,
        model_name,
        note,
        note_color,
        ex_agent_session_id,
        ex_agent_type,
        content_blocks,
        created_at,
        // Additional context for dependency creation
        user_id,
        owner_id,
        project_id,
      } = req.body

      // console.log(
      //   '[LocalServer] 💾 POST /api/sync/message - messageId:',
      //   id,
      //   'conversationId:',
      //   conversation_id,
      //   'role:',
      //   role
      // )
      // console.log('[LocalServer] 📝 Message content preview:', content?.substring(0, 50))

      if (!conversation_id) {
        // console.log('[LocalServer] ❌ Missing conversation_id')
        res.status(400).json({ error: 'Missing conversation_id' })
        return
      }

      // Ensure conversation exists before upserting message
      // Try to get user_id from request body or from existing conversation
      let effectiveUserId = user_id || owner_id
      let effectiveProjectId = project_id

      // If no user_id provided, try to get it from the existing conversation
      if (!effectiveUserId && db) {
        const existingConv = db
          .prepare('SELECT user_id, project_id FROM conversations WHERE id = ?')
          .get(conversation_id) as { user_id: string; project_id: string | null } | undefined
        if (existingConv) {
          effectiveUserId = existingConv.user_id
          effectiveProjectId = effectiveProjectId || existingConv.project_id
        }
      }

      // If we have user context, ensure dependencies exist
      if (effectiveUserId) {
        ensureConversationExists(conversation_id, effectiveUserId, effectiveProjectId || null)
      } else {
        // No user context and conversation doesn't exist - this will fail on FK constraint
        // Log warning but proceed anyway (might succeed if conversation exists)
        console.warn('[LocalServer] No user context for message sync, conversation may not exist:', conversation_id)
      }

      const messageCreatedAt = created_at || new Date().toISOString()
      const normalizedContentBlocks =
        typeof content_blocks === 'string' ? content_blocks : JSON.stringify(content_blocks || null)

      if (role === 'assistant' || role === 'ex_agent') {
        const thinkingText = typeof thinking_block === 'string' ? thinking_block.trim() : ''
        if (thinkingText.length > 0) {
          let parsedBlocks: any[] = []
          try {
            const parsed =
              typeof normalizedContentBlocks === 'string' && normalizedContentBlocks
                ? JSON.parse(normalizedContentBlocks)
                : null
            parsedBlocks = Array.isArray(parsed) ? parsed : []
          } catch {
            parsedBlocks = []
          }

          const hasThinkingBlock = parsedBlocks.some(block => block?.type === 'thinking')
          const hasResponsesReasoning = parsedBlocks.some(block => {
            if (block?.type !== 'responses_output_items' || !Array.isArray(block?.items)) return false
            return block.items.some((item: any) => item?.type === 'reasoning')
          })

          if (!hasThinkingBlock && !hasResponsesReasoning) {
            console.debug('[LocalServer][sync/message] Assistant message has thinking_block but no reasoning persisted in content_blocks', {
              messageId: id,
              conversationId: conversation_id,
              role,
              thinkingLength: thinkingText.length,
              contentBlocksLength: parsedBlocks.length,
            })
          }
        }
      }

      statements.upsertMessage.run(
        id,
        conversation_id,
        parent_id || null,
        typeof children_ids === 'string' ? children_ids : JSON.stringify(children_ids || []),
        role,
        content,
        plain_text_content || null,
        thinking_block || null,
        typeof tool_calls === 'string' ? tool_calls : JSON.stringify(tool_calls || null),
        tool_call_id || null,
        model_name || 'unknown',
        note || null,
        note_color || null,
        ex_agent_session_id || null,
        ex_agent_type || null,
        normalizedContentBlocks,
        messageCreatedAt
      )

      // Update conversation/project timestamps to reflect recent activity
      if (db) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(messageCreatedAt, conversation_id)

        let projectIdToTouch = effectiveProjectId
        if (!projectIdToTouch) {
          const conversationRow = db
            .prepare('SELECT project_id FROM conversations WHERE id = ?')
            .get(conversation_id) as { project_id: string | null } | undefined
          projectIdToTouch = conversationRow?.project_id || null
        }

        if (projectIdToTouch) {
          db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(messageCreatedAt, projectIdToTouch)
        }
      }

      // Process any image content_blocks and save them locally before responding so the
      // caller can persist an exact generated-image path hint instead of a generic folder pattern.
      const generatedImageFilePathsSet = new Set<string>(extractGeneratedImageFilePathsFromContentBlocks(content_blocks))
      const parsedBlocks = typeof content_blocks === 'string' ? JSON.parse(content_blocks) : content_blocks
      if (Array.isArray(parsedBlocks)) {
        const imageBlocks = parsedBlocks.filter((block: any) => block.type === 'image' && block.url)
        if (imageBlocks.length > 0) {
          console.log('[LocalServer] Found generated image blocks to save', {
            messageId: id,
            count: imageBlocks.length,
            mimeTypes: imageBlocks.map((block: any) => block.mimeType || 'image/png'),
            urlTypes: imageBlocks.map((block: any) =>
              typeof block.url === 'string' && block.url.startsWith('data:') ? 'data-url' : 'url'
            ),
          })
        }
        for (const imageBlock of imageBlocks) {
          const existingPath =
            typeof imageBlock.filePath === 'string'
              ? imageBlock.filePath
              : typeof imageBlock.file_path === 'string'
                ? imageBlock.file_path
                : null
          if (existingPath && existingPath.trim()) {
            generatedImageFilePathsSet.add(existingPath.trim())
            continue
          }

          try {
            const result = await saveGeneratedImage(id, imageBlock.url, imageBlock.mimeType || 'image/png')
            console.log('[LocalServer] Generated image save result', {
              messageId: id,
              saved: Boolean(result),
              filePath: result?.filePath,
              attachmentId: result?.attachmentId,
            })
            if (result?.filePath) {
              generatedImageFilePathsSet.add(result.filePath)
            }
          } catch (err) {
            console.error('[LocalServer] Failed to save generated image:', err)
          }
        }
      } else if (content_blocks) {
        console.warn('[LocalServer] content_blocks was not an array; generated image save skipped', {
          messageId: id,
          contentBlocksType: typeof content_blocks,
        })
      }

      const generatedImageFilePaths = Array.from(generatedImageFilePathsSet)
      res.json({ success: true, id, generatedImageFilePaths })
    } catch (error) {
      console.error('[LocalServer] ❌ Error syncing message:', error)
      res.status(500).json({ error: 'Failed to sync message' })
    }
  })

  app.delete('/api/sync/message/:id', (req, res) => {
    try {
      const { id } = req.params
      statements.deleteMessage.run(id)
      // console.log('[LocalServer] Deleted message:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error deleting message:', error)
      res.status(500).json({ error: 'Failed to delete message' })
    }
  })

  // Sync Attachment
  app.post('/api/sync/attachment', (req, res) => {
    try {
      const {
        id,
        message_id,
        kind,
        mime_type,
        storage,
        url,
        file_path,
        width,
        height,
        size_bytes,
        sha256,
        created_at,
      } = req.body

      let attachmentId = id

      // Check if attachment with this sha256 already exists (deduplication)
      if (sha256) {
        const existingAttachment = statements.getAttachmentBySha256.get(sha256) as { id: string } | undefined

        if (existingAttachment && existingAttachment.id !== id) {
          // Attachment with same content already exists - reuse it
          attachmentId = existingAttachment.id
        } else if (!existingAttachment) {
          // Create new attachment
          statements.upsertAttachment.run(
            id,
            message_id || null,
            kind,
            mime_type,
            storage || 'url',
            url || null,
            file_path || null,
            width || null,
            height || null,
            size_bytes || null,
            sha256,
            created_at || new Date().toISOString(),
            null
          )
        }
        // If existingAttachment.id === id, do nothing (already exists with same ID)
      } else {
        // No sha256 provided, just upsert by ID
        statements.upsertAttachment.run(
          id,
          message_id || null,
          kind,
          mime_type,
          storage || 'url',
          url || null,
          file_path || null,
          width || null,
          height || null,
          size_bytes || null,
          sha256 || null,
          created_at || new Date().toISOString(),
          null
        )
      }

      // Link attachment to message if message_id provided
      if (message_id) {
        const linkId = uuidv4()
        statements.linkAttachment.run(linkId, message_id, attachmentId, new Date().toISOString())
      }

      // console.log('[LocalServer] Synced attachment:', attachmentId)
      res.json({ success: true, id: attachmentId })
    } catch (error) {
      console.error('[LocalServer] Error syncing attachment:', error)
      res.status(500).json({ error: 'Failed to sync attachment' })
    }
  })

  // Persist image drafts before their user message exists. This gives the model a durable
  // path it can pass to view_image during the first generation turn.
  app.post('/api/local/attachments/prepare-base64', (req, res) => {
    try {
      const { attachments } = req.body as {
        attachments: Array<{ dataUrl: string; name?: string; type?: string; size?: number }>
      }
      if (!Array.isArray(attachments) || attachments.length === 0) {
        res.status(400).json({ error: 'attachments array required' })
        return
      }
      const currentDbPath = getCurrentDbPath()
      if (!db || !statements || !currentDbPath) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }

      const imagesDir = path.join(path.dirname(currentDbPath), 'user_images')
      fs.mkdirSync(imagesDir, { recursive: true })
      const savedAttachments: Array<{ id: string; file_path: string; sha256: string; mime_type: string; size_bytes: number }> = []

      for (const attachment of attachments) {
        const matches = typeof attachment.dataUrl === 'string' && attachment.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
        if (!matches || !matches[1].startsWith('image/')) {
          res.status(400).json({ error: 'attachments must be image base64 data URLs' })
          return
        }
        const mimeType = matches[1].toLowerCase()
        const buffer = Buffer.from(matches[2], 'base64')
        if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) {
          res.status(400).json({ error: 'attachment image must be between 1 byte and 20 MB' })
          return
        }
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
        const extByMime: Record<string, string> = {
          'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif',
        }
        const ext = extByMime[mimeType]
        if (!ext) {
          res.status(400).json({ error: `unsupported image MIME type: ${mimeType}` })
          return
        }
        const filePath = path.join(imagesDir, `${sha256}.${ext}`)
        if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer)
        const existing = statements.getAttachmentBySha256.get(sha256) as { id: string; file_path: string } | undefined
        const attachmentId = existing?.id || uuidv4()
        const persistedPath = existing?.file_path || filePath
        if (!existing) {
          statements.upsertAttachment.run(
            attachmentId, null, 'image', mimeType, 'file', null, persistedPath, null, null, buffer.length, sha256,
            new Date().toISOString(), null
          )
        }
        savedAttachments.push({ id: attachmentId, file_path: persistedPath, sha256, mime_type: mimeType, size_bytes: buffer.length })
      }
      res.json({ success: true, attachments: savedAttachments })
    } catch (error) {
      console.error('[LocalServer] Error preparing base64 attachments:', error)
      res.status(500).json({ error: 'Failed to prepare attachments' })
    }
  })

  // Link already-persisted attachment records once the user message has been created.
  app.post('/api/local/attachments/link', (req, res) => {
    try {
      const { messageId, attachmentIds } = req.body as { messageId: string; attachmentIds: string[] }
      if (!messageId || !Array.isArray(attachmentIds) || attachmentIds.length === 0) {
        res.status(400).json({ error: 'messageId and attachmentIds array required' })
        return
      }
      if (!statements || !statements.getMessageById.get(messageId)) {
        res.status(409).json({ error: 'message_not_found', messageId })
        return
      }
      const now = new Date().toISOString()
      for (const attachmentId of new Set(attachmentIds)) {
        if (!statements.getAttachmentById.get(attachmentId)) continue
        statements.linkAttachment.run(uuidv4(), messageId, attachmentId, now)
      }
      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] Error linking prepared attachments:', error)
      res.status(500).json({ error: 'Failed to link attachments' })
    }
  })

  // Save base64 image attachments for a message (used by local-only mode)
  app.post('/api/local/attachments/save-base64', (req, res) => {
    try {
      const { messageId, attachments } = req.body as {
        messageId: string
        attachments: Array<{
          dataUrl: string
          name?: string
          type?: string
          size?: number
        }>
      }

      if (!messageId || !attachments || !Array.isArray(attachments) || attachments.length === 0) {
        res.status(400).json({ error: 'messageId and attachments array required' })
        return
      }

      const currentDbPath = getCurrentDbPath()
      if (!db || !statements || !currentDbPath) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }

      const existingMessage = statements.getMessageById.get(messageId) as { id: string } | undefined
      if (!existingMessage) {
        console.warn('[LocalServer] Cannot save base64 attachments: message not found', {
          messageId,
          attachmentCount: attachments.length,
        })
        res.status(409).json({ error: 'message_not_found', messageId })
        return
      }

      const savedAttachments: Array<{ id: string; file_path: string }> = []
      const imagesDir = path.join(path.dirname(currentDbPath), 'user_images')

      // Ensure directory exists
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true })
      }

      for (const attachment of attachments) {
        try {
          const { dataUrl } = attachment

          // Parse data URL: data:image/png;base64,xxxxx
          const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
          if (!matches) {
            console.warn('[LocalServer] Invalid data URL format, skipping')
            continue
          }

          const mimeType = matches[1]
          const base64Data = matches[2]
          const buffer = Buffer.from(base64Data, 'base64')

          // Calculate SHA256 for deduplication
          const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')

          // Determine file extension
          const ext = mimeType.split('/')[1] || 'png'
          const fileName = `${sha256}.${ext}`
          const filePath = path.join(imagesDir, fileName)

          // Write file (skip if already exists - deduplication)
          if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, buffer)
          }

          const now = new Date().toISOString()

          // Check if attachment with this sha256 already exists (deduplication)
          const existingAttachment = statements.getAttachmentBySha256.get(sha256) as
            | { id: string; file_path: string }
            | undefined

          let attachmentId: string

          if (existingAttachment) {
            // Reuse existing attachment - just create a link to it
            attachmentId = existingAttachment.id
          } else {
            // Create new attachment record
            attachmentId = uuidv4()
            statements.upsertAttachment.run(
              attachmentId,
              messageId,
              'image',
              mimeType,
              'file',
              null, // url
              filePath,
              null, // width
              null, // height
              buffer.length,
              sha256,
              now,
              null
            )
          }

          // Link attachment to message (INSERT OR IGNORE handles duplicate links gracefully)
          statements.linkAttachment.run(uuidv4(), messageId, attachmentId, now)

          savedAttachments.push({ id: attachmentId, file_path: filePath })
        } catch (attachmentError) {
          console.error('[LocalServer] Error saving individual attachment:', attachmentError)
        }
      }

      res.json({ success: true, attachments: savedAttachments })
    } catch (error) {
      console.error('[LocalServer] Error saving base64 attachments:', error)
      res.status(500).json({ error: 'Failed to save attachments' })
    }
  })

  // Serve local attachment file by ID
  app.get('/api/local/attachments/:id/file', (req, res) => {
    try {
      const { id } = req.params

      if (!db || !statements) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }

      const attachment = statements.getAttachmentById.get(id) as
        | {
            id: string
            file_path: string | null
            url: string | null
            mime_type: string
          }
        | undefined

      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }

      // If it's a URL-based attachment, redirect
      if (attachment.url) {
        res.redirect(attachment.url)
        return
      }

      // If it's a file-based attachment, serve the file
      if (attachment.file_path) {
        if (!fs.existsSync(attachment.file_path)) {
          res.status(404).json({ error: 'File not found on disk' })
          return
        }

        res.setHeader('Content-Type', attachment.mime_type || 'application/octet-stream')
        res.setHeader('Cache-Control', 'public, max-age=31536000') // Cache for 1 year (content-addressed)
        const stream = fs.createReadStream(attachment.file_path)
        stream.pipe(res)
        return
      }

      res.status(404).json({ error: 'No file path or URL for attachment' })
    } catch (error) {
      console.error('[LocalServer] Error serving attachment file:', error)
      res.status(500).json({ error: 'Failed to serve attachment' })
    }
  })

  // Sync Provider Cost
  app.post('/api/sync/provider-cost', (req, res) => {
    try {
      const {
        id,
        user_id,
        message_id,
        prompt_tokens,
        completion_tokens,
        reasoning_tokens,
        approx_cost,
        api_credit_cost,
        created_at,
      } = req.body

      statements.upsertProviderCost.run(
        id,
        user_id,
        message_id,
        prompt_tokens || 0,
        completion_tokens || 0,
        reasoning_tokens || 0,
        approx_cost || 0,
        api_credit_cost || 0,
        created_at || new Date().toISOString()
      )
      // console.log('[LocalServer] Synced provider cost:', id)
      res.json({ success: true, id })
    } catch (error) {
      console.error('[LocalServer] Error syncing provider cost:', error)
      res.status(500).json({ error: 'Failed to sync provider cost' })
    }
  })

  // Batch sync endpoint for efficiency
  app.post('/api/sync/batch', (req, res) => {
    const { operations } = req.body as { operations: Array<{ type: string; action: string; data: any }> }

    if (!Array.isArray(operations)) {
      res.status(400).json({ error: 'Operations must be an array' })
      return
    }

    const results: Array<{ success: boolean; type: string; id?: string; error?: string }> = []

    // Use transaction for atomicity
    const transaction = db!.transaction(() => {
      for (const op of operations) {
        try {
          switch (op.type) {
            case 'user':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertUser.run(op.data.id, op.data.username, op.data.created_at || new Date().toISOString())
                results.push({ success: true, type: 'user', id: op.data.id })
              }
              break

            case 'project':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertProject.run(
                  op.data.id,
                  op.data.name,
                  op.data.user_id,
                  op.data.context || null,
                  op.data.system_prompt || null,
                  op.data.cwd || null,
                  op.data.storage_mode || 'cloud',
                  op.data.created_at || new Date().toISOString(),
                  op.data.updated_at || new Date().toISOString()
                )
                results.push({ success: true, type: 'project', id: op.data.id })
              } else if (op.action === 'delete') {
                statements.deleteProject.run(op.data.id)
                results.push({ success: true, type: 'project', id: op.data.id })
              }
              break

            case 'conversation':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertConversation.run(
                  op.data.id,
                  op.data.project_id || null,
                  op.data.user_id,
                  op.data.title || null,
                  op.data.model_name || 'unknown',
                  op.data.system_prompt || null,
                  op.data.conversation_context || null,
                  op.data.research_note || null,
                  op.data.cwd || null,
                  op.data.storage_mode || 'cloud',
                  op.data.created_at || new Date().toISOString(),
                  op.data.updated_at || new Date().toISOString()
                )
                results.push({ success: true, type: 'conversation', id: op.data.id })
              } else if (op.action === 'delete') {
                statements.deleteConversation.run(op.data.id)
                results.push({ success: true, type: 'conversation', id: op.data.id })
              }
              break

            case 'message':
              if (op.action === 'create' || op.action === 'update') {
                statements.upsertMessage.run(
                  op.data.id,
                  op.data.conversation_id,
                  op.data.parent_id || null,
                  typeof op.data.children_ids === 'string'
                    ? op.data.children_ids
                    : JSON.stringify(op.data.children_ids || []),
                  op.data.role,
                  op.data.content,
                  op.data.plain_text_content || null,
                  op.data.thinking_block || null,
                  typeof op.data.tool_calls === 'string'
                    ? op.data.tool_calls
                    : JSON.stringify(op.data.tool_calls || null),
                  op.data.tool_call_id || null,
                  op.data.model_name || 'unknown',
                  op.data.note || null,
                  op.data.note_color || null,
                  op.data.ex_agent_session_id || null,
                  op.data.ex_agent_type || null,
                  typeof op.data.content_blocks === 'string'
                    ? op.data.content_blocks
                    : JSON.stringify(op.data.content_blocks || null),
                  op.data.created_at || new Date().toISOString()
                )
                results.push({ success: true, type: 'message', id: op.data.id })
              } else if (op.action === 'delete') {
                statements.deleteMessage.run(op.data.id)
                results.push({ success: true, type: 'message', id: op.data.id })
              }
              break

            default:
              results.push({ success: false, type: op.type, error: `Unknown operation type: ${op.type}` })
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          results.push({ success: false, type: op.type, error: errorMsg })
        }
      }
    })

    try {
      transaction()
      // console.log(
      //   `[LocalServer] Batch sync completed: ${results.filter(r => r.success).length}/${operations.length} succeeded`
      // )
      res.json({ success: true, results })
    } catch (error) {
      console.error('[LocalServer] Batch sync failed:', error)
      res.status(500).json({ error: 'Batch sync failed', results })
    }
  })
}
