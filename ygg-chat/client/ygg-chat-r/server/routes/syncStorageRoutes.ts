// server/routes/syncStorageRoutes.ts
//
// Local attachment binary endpoints (/api/local/attachments/*). The old
// /api/sync/* cloud-mirror routes were removed when Graviton became fully
// local; /api/sync/stats lives in analyticsRoutes.ts.
//
// deps.db/statements come from initializeLocalDatabase(); registration
// happens after DB init. getCurrentDbPath() stays a getter because the
// attachment directory is resolved next to the live DB file.

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
}
