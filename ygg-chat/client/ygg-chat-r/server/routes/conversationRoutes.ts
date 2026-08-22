// server/routes/conversationRoutes.ts
//
// Local conversation + message CRUD APIs, extracted verbatim from
// localServer.ts setupServer(): /api/local/conversations (list,
// favorites, create, patch, favorite toggle, get, delete), the
// per-conversation message endpoints (list, top-level-users, tree,
// bulk), and /api/local/messages/* (update, delete, deleteMany).
//
// Registered AFTER registerNoteSearchRoutes so the literal
// /api/local/conversations/search* paths keep matching before the
// /api/local/conversations/:id parameter routes.

import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { v4 as uuidv4 } from 'uuid'

// ChatNode interface for message tree structure
interface ChatNode {
  id: string
  message: string
  sender: 'user' | 'assistant'
  children: ChatNode[]
}

// Build tree structure from flat message array with children_ids
function buildMessageTree(messages: any[]): ChatNode | null {
  if (!messages || messages.length === 0) return null

  const messageMap = new Map<string, ChatNode>()
  const rootNodes: ChatNode[] = []

  // Create nodes
  messages.forEach(msg => {
    messageMap.set(msg.id, {
      id: msg.id.toString(),
      message: msg.content,
      sender: msg.role as 'user' | 'assistant',
      children: [],
    })
  })

  // Build tree using children_ids and collect all root nodes
  messages.forEach(msg => {
    const node = messageMap.get(msg.id)!

    if (msg.parent_id === null) {
      rootNodes.push(node)
    }

    // Add children using children_ids array
    const childIds = msg.children_ids || []
    childIds.forEach((childId: string) => {
      const childNode = messageMap.get(childId)
      if (childNode) {
        node.children.push(childNode)
      }
    })
  })

  if (rootNodes.length === 0) return null

  // If only one root message, return it directly
  if (rootNodes.length === 1) {
    return rootNodes[0]
  }

  // Multiple roots → create a synthetic root node containing all root branches
  // This preserves all independent conversation trees
  return {
    id: 'root',
    message: 'Conversation',
    sender: 'assistant',
    children: rootNodes,
  }
}

export interface ConversationRoutesDeps {
  db: Database.Database
  statements: any
}

export function registerConversationRoutes(app: Express, deps: ConversationRoutesDeps): void {
  const { db, statements } = deps

  // GET /api/local/conversations?userId=xxx[&projectId=yyy][&limit=50&cursor=0]
  app.get('/api/local/conversations', (req, res) => {
    try {
      const userId = req.query.userId as string
      const projectId = (req.query.projectId as string | undefined) || undefined
      const limitParam = req.query.limit as string | undefined
      const cursorParam = req.query.cursor as string | undefined
      // console.log('[LocalServer] 📋 GET /api/local/conversations - userId:', userId, 'projectId:', projectId)
      if (!userId) {
        // console.log('[LocalServer] ❌ Missing userId parameter')
        res.status(400).json({ error: 'userId required' })
        return
      }

      if (limitParam) {
        const parsedLimit = Number(limitParam)
        const parsedOffset = cursorParam ? Number(cursorParam) : 0
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(200, Math.floor(parsedLimit))) : 50
        const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : 0
        const rows = projectId
          ? statements.getLocalConversationsByUserAndProjectPaginated.all(userId, projectId, limit + 1, offset)
          : statements.getLocalConversationsPaginated.all(userId, limit + 1, offset)
        const hasMore = rows.length > limit
        const conversations = hasMore ? rows.slice(0, limit) : rows

        res.json({
          conversations,
          nextCursor: hasMore ? String(offset + limit) : null,
          hasMore,
        })
        return
      }

      const conversations = projectId
        ? statements.getLocalConversationsByUserAndProject.all(userId, projectId)
        : statements.getLocalConversations.all(userId)

      // console.log('[LocalServer] ✅ Found', conversations.length, 'local conversations for user:', userId)
      // console.log('[LocalServer] 📊 Conversations:', JSON.stringify(conversations, null, 2))
      res.json(conversations)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching local conversations:', error)
      res.status(500).json({ error: 'Failed to fetch conversations' })
    }
  })

  // GET /api/local/conversations/favorites?userId=xxx&limit=xx
  app.get('/api/local/conversations/favorites', (req, res) => {
    try {
      const userId = req.query.userId as string
      const limitParam = req.query.limit as string | undefined
      if (!userId) {
        res.status(400).json({ error: 'userId required' })
        return
      }

      const limit = limitParam ? Number(limitParam) : undefined
      const conversations = Number.isFinite(limit)
        ? statements.getFavoriteConversationsLimited.all(userId, limit)
        : statements.getFavoriteConversations.all(userId)

      res.json(conversations)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching favorite conversations:', error)
      res.status(500).json({ error: 'Failed to fetch favorite conversations' })
    }
  })

  // POST /api/local/conversations
  app.post('/api/local/conversations', (req, res) => {
    try {
      const { id, user_id, project_id, title, system_prompt, conversation_context, cwd } = req.body
      if (!user_id) {
        res.status(400).json({ error: 'user_id required' })
        return
      }

      const conversationId = id || uuidv4()
      const now = new Date().toISOString()
      const project = project_id ? (statements.getProjectById.get(project_id) as any) : null
      const inheritedCwd = cwd !== undefined ? cwd : project?.cwd || null

      statements.upsertConversation.run(
        conversationId,
        project_id || null,
        user_id,
        title || null,
        'unknown', // model_name
        system_prompt || null,
        conversation_context || null,
        null, // research_note
        inheritedCwd || null, // cwd
        'local', // storage_mode
        now,
        now
      )

      // Touch parent project timestamp so project ordering reflects latest conversation activity
      if (project_id) {
        db!.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project_id)
      }

      const created = statements.getConversationById.get(conversationId)
      res.status(201).json(created)
    } catch (error) {
      console.error('[LocalServer] Error creating local conversation:', error)
      res.status(500).json({ error: 'Failed to create conversation' })
    }
  })

  // PATCH /api/local/conversations/:id
  // Handles: title, system_prompt, conversation_context, research_note, cwd
  app.patch('/api/local/conversations/:id', (req, res) => {
    try {
      const { id } = req.params
      const { title, system_prompt, conversation_context, research_note, cwd } = req.body

      const existing = statements.getConversationById.get(id) as any
      if (!existing) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      // Build dynamic update - only update fields that are provided (not undefined)
      const updates: string[] = []
      const values: any[] = []

      if (title !== undefined) {
        updates.push('title = ?')
        values.push(title)
      }
      if (system_prompt !== undefined) {
        updates.push('system_prompt = ?')
        values.push(system_prompt)
      }
      if (conversation_context !== undefined) {
        updates.push('conversation_context = ?')
        values.push(conversation_context)
      }
      if (research_note !== undefined) {
        updates.push('research_note = ?')
        values.push(research_note)
      }
      if (cwd !== undefined) {
        updates.push('cwd = ?')
        values.push(cwd)
      }

      if (updates.length === 0) {
        // Nothing to update, just return existing
        res.json(existing)
        return
      }

      // Always update updated_at
      updates.push('updated_at = CURRENT_TIMESTAMP')
      values.push(id) // for WHERE clause

      const sql = `UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`
      db!.prepare(sql).run(...values)

      const updated = statements.getConversationById.get(id)
      // console.log('[LocalServer] Updated local conversation:', id, '- fields:', Object.keys(req.body).join(', '))
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating conversation:', error)
      res.status(500).json({ error: 'Failed to update conversation' })
    }
  })

  // PATCH /api/local/conversations/:id/favorite
  app.patch('/api/local/conversations/:id/favorite', (req, res) => {
    try {
      const { id } = req.params
      const { favorite } = req.body || {}

      if (favorite === undefined) {
        res.status(400).json({ error: 'favorite required' })
        return
      }

      const existing = statements.getConversationById.get(id)
      if (!existing) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      const normalizedFavorite = favorite === true || favorite === 1 || favorite === '1' || favorite === 'true' ? 1 : 0

      statements.updateConversationFavorite.run(normalizedFavorite, id)
      const updated = statements.getConversationById.get(id)
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating conversation favorite:', error)
      res.status(500).json({ error: 'Failed to update favorite' })
    }
  })

  // GET /api/local/conversations/:id
  app.get('/api/local/conversations/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🔍 GET /api/local/conversations/:id - conversationId:', id)
      const conversation = statements.getConversationById.get(id)

      if (!conversation) {
        // console.log('[LocalServer] ❌ Conversation not found:', id)
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      // console.log('[LocalServer] ✅ Found conversation:', JSON.stringify(conversation, null, 2))
      res.json(conversation)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching conversation:', error)
      res.status(500).json({ error: 'Failed to fetch conversation' })
    }
  })

  // DELETE /api/local/conversations/:id
  app.delete('/api/local/conversations/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🗑️ DELETE /api/local/conversations/:id - conversationId:', id)
      statements.deleteConversation.run(id)
      // console.log('[LocalServer] ✅ Conversation deleted:', id)
      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] ❌ Error deleting conversation:', error)
      res.status(500).json({ error: 'Failed to delete conversation' })
    }
  })

  // GET /api/local/conversations/:id/messages
  app.get('/api/local/conversations/:id/messages', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 💬 GET /api/local/conversations/:id/messages - conversationId:', id)
      const messages = statements.getMessagesByConversationId.all(id)
      // console.log('[LocalServer] ✅ Found', messages.length, 'messages for conversation:', id)
      // if (messages.length > 0) {
      //   console.log('[LocalServer] 📊 First message:', JSON.stringify(messages[0], null, 2))
      //   console.log('[LocalServer] 📊 Last message:', JSON.stringify(messages[messages.length - 1], null, 2))
      // }
      res.json(messages)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching messages:', error)
      res.status(500).json({ error: 'Failed to fetch messages' })
    }
  })

  // GET /api/local/conversations/:id/messages/top-level-users
  app.get('/api/local/conversations/:id/messages/top-level-users', (req, res) => {
    try {
      const { id } = req.params
      const topLevelUserMessages = statements.getTopLevelUserMessagesByConversationId.all(id)
      res.json(topLevelUserMessages)
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching top-level user messages:', error)
      res.status(500).json({ error: 'Failed to fetch top-level user messages' })
    }
  })

  // GET /api/local/conversations/:id/messages/tree
  app.get('/api/local/conversations/:id/messages/tree', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🌲 GET /api/local/conversations/:id/messages/tree - conversationId:', id)
      const messages = statements.getMessagesByConversationId.all(id)
      // console.log('[LocalServer] 📦 Raw messages fetched:', messages.length)

      // Parse JSON fields (children_ids, tool_calls, content_blocks) and fetch attachments
      const normalizedMessages = messages.map((msg: any) => {
        // Fetch attachments for this message
        const attachments = statements.getAttachmentsByMessageId.all(msg.id) as any[]

        return {
          ...msg,
          children_ids: msg.children_ids ? JSON.parse(msg.children_ids) : [],
          tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null,
          content_blocks: msg.content_blocks ? JSON.parse(msg.content_blocks) : null,
          attachments,
          attachments_count: attachments.length,
          has_attachments: attachments.length > 0,
        }
      })

      // console.log('[LocalServer] ✨ Normalized messages:', normalizedMessages.length)
      // if (normalizedMessages.length > 0) {
      //   console.log('[LocalServer] 📊 Sample normalized message:', JSON.stringify(normalizedMessages[0], null, 2))
      // }

      const treeData = buildMessageTree(normalizedMessages)
      // console.log('[LocalServer] 🌳 Tree built successfully:', treeData ? 'Has tree' : 'No tree')
      // if (treeData) {
      //   console.log(
      //     '[LocalServer] 🌳 Tree root:',
      //     JSON.stringify({ id: treeData.id, childCount: treeData.children.length }, null, 2)
      //   )
      // }

      // Get storage_mode from conversation
      const conversation = statements.getConversationById.get(id) as { storage_mode: string } | undefined
      const storage_mode = conversation?.storage_mode || 'local'

      res.json({ messages: normalizedMessages, tree: treeData, meta: { storage_mode } })
    } catch (error) {
      console.error('[LocalServer] ❌ Error fetching message tree:', error)
      res.status(500).json({ error: 'Failed to fetch message tree' })
    }
  })

  // POST /api/local/conversations/:id/messages/bulk
  // Bulk insert messages (for copying message chains to new conversation)
  app.post('/api/local/conversations/:id/messages/bulk', (req, res) => {
    try {
      const { id: conversationId } = req.params
      const { messages } = req.body as {
        messages: Array<{
          source_id?: string
          parent_source_id?: string | null
          role: 'user' | 'assistant' | 'system' | 'ex_agent' | 'tool'
          content: string
          thinking_block?: string
          model_name?: string
          tool_calls?: string | any
          note?: string
          note_color?: string | null
          content_blocks?: any
        }>
      }

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'Messages array required' })
        return
      }

      // Verify conversation exists
      const conversation = statements.getConversationById.get(conversationId) as
        | { user_id: string; title?: string }
        | undefined
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' })
        return
      }

      const createdMessages: any[] = []
      let lastMessageId: string | null = null
      const now = new Date().toISOString()
      const sourceIdToNewId = new Map<string, string>()
      const hasStructuredParents = messages.some(msg => msg.source_id != null || msg.parent_source_id !== undefined)

      messages.forEach((msg, index) => {
        const sourceKey = msg.source_id != null ? String(msg.source_id) : `__legacy_${index}`
        sourceIdToNewId.set(sourceKey, uuidv4())
      })

      const entries = messages.map((msg, index) => ({ msg, index }))
      const orderedEntries: typeof entries = []

      if (hasStructuredParents) {
        const entryBySourceKey = new Map(entries.map(entry => [entry.msg.source_id != null ? String(entry.msg.source_id) : `__legacy_${entry.index}`, entry]))
        const visitedEntries = new Set<string>()

        const visitEntry = (entry: (typeof entries)[number]) => {
          const sourceKey = entry.msg.source_id != null ? String(entry.msg.source_id) : `__legacy_${entry.index}`
          if (visitedEntries.has(sourceKey)) return

          const parentEntry = entry.msg.parent_source_id != null ? entryBySourceKey.get(String(entry.msg.parent_source_id)) : null
          if (parentEntry) visitEntry(parentEntry)

          visitedEntries.add(sourceKey)
          orderedEntries.push(entry)
        }

        entries.forEach(visitEntry)
      } else {
        orderedEntries.push(...entries)
      }

      // Insert messages sequentially. Structured Heimdall clone payloads preserve
      // selected parent/child relationships; legacy payloads keep the old linear
      // chain behavior for backward compatibility.
      for (const { msg, index } of orderedEntries) {
        const sourceKey = msg.source_id != null ? String(msg.source_id) : `__legacy_${index}`
        const messageId = sourceIdToNewId.get(sourceKey) || uuidv4()
        const parentId = hasStructuredParents
          ? msg.parent_source_id != null
            ? sourceIdToNewId.get(String(msg.parent_source_id)) || null
            : null
          : lastMessageId

        statements.upsertMessage.run(
          messageId,
          conversationId,
          parentId,
          '[]', // children_ids starts empty (trigger will update parent's children_ids)
          msg.role,
          msg.content,
          msg.content, // plain_text_content
          msg.thinking_block || null,
          msg.tool_calls
            ? typeof msg.tool_calls === 'string'
              ? msg.tool_calls
              : JSON.stringify(msg.tool_calls)
            : null,
          null, // tool_call_id
          msg.model_name || 'unknown',
          msg.note || null,
          msg.note_color || null,
          null, // ex_agent_session_id
          null, // ex_agent_type
          msg.content_blocks
            ? typeof msg.content_blocks === 'string'
              ? msg.content_blocks
              : JSON.stringify(msg.content_blocks)
            : null,
          now
        )

        const createdMessage = {
          id: messageId,
          conversation_id: conversationId,
          parent_id: parentId,
          children_ids: [],
          role: msg.role,
          content: msg.content,
          plain_text_content: msg.content,
          thinking_block: msg.thinking_block || null,
          tool_calls: msg.tool_calls || null,
          model_name: msg.model_name || 'unknown',
          note: msg.note || null,
          note_color: msg.note_color || null,
          content_blocks: msg.content_blocks || null,
          created_at: now,
        }

        createdMessages.push(createdMessage)
        lastMessageId = messageId
      }

      // Auto-generate title if this is the first message chain and title is empty
      if (!conversation.title && messages.length > 0) {
        const firstContent = messages[0].content
        const title = firstContent.slice(0, 100) + (firstContent.length > 100 ? '...' : '')
        statements.updateConversationTitle.run(title, conversationId)
      }

      // Update conversation updated_at timestamp
      if (db) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
      }

      console.log(
        '[LocalServer] ✅ Bulk inserted',
        createdMessages.length,
        'messages into conversation:',
        conversationId
      )
      res.json({ messages: createdMessages })
    } catch (error) {
      console.error('[LocalServer] ❌ Error bulk inserting messages:', error)
      res.status(500).json({ error: 'Failed to bulk insert messages' })
    }
  })

  // PUT /api/local/messages/:id
  app.put('/api/local/messages/:id', (req, res) => {
    try {
      const { id } = req.params
      const { content, note, note_color, content_blocks } = req.body

      // Same logic as server route
      let finalContent = content
      if (!content && content_blocks) {
        const textBlocks = Array.isArray(content_blocks) ? content_blocks.filter((b: any) => b.type === 'text') : []
        finalContent = textBlocks.map((b: any) => b.text || '').join('\n')
      }

      const contentBlocksJson = content_blocks ? JSON.stringify(content_blocks) : null

      // Check if message exists
      const existing = statements.getMessageById.get(id)
      if (!existing) {
        res.status(404).json({ error: 'Message not found' })
        return
      }

      // Update message
      statements.updateMessage.run(
        finalContent ?? existing.content,
        note !== undefined ? note : existing.note,
        note_color !== undefined ? note_color : existing.note_color,
        contentBlocksJson ?? existing.content_blocks,
        id
      )

      const updated = statements.getMessageById.get(id)
      res.json(updated)
    } catch (error) {
      console.error('[LocalServer] Error updating message:', error)
      res.status(500).json({ error: 'Failed to update message' })
    }
  })

  // DELETE /api/local/messages/:id
  app.delete('/api/local/messages/:id', (req, res) => {
    try {
      const { id } = req.params
      // console.log('[LocalServer] 🗑️ DELETE /api/local/messages/:id - messageId:', id)
      statements.deleteMessage.run(id)
      // console.log('[LocalServer] ✅ Message deleted:', id)
      res.json({ success: true })
    } catch (error) {
      console.error('[LocalServer] ❌ Error deleting message:', error)
      res.status(500).json({ error: 'Failed to delete message' })
    }
  })

  // POST /api/local/messages/deleteMany - Bulk delete messages
  app.post('/api/local/messages/deleteMany', (req, res) => {
    try {
      const { ids } = req.body
      // console.log('[LocalServer] 🗑️ POST /api/local/messages/deleteMany - ids:', ids)

      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: 'ids must be a non-empty array' })
        return
      }

      // Delete each message in a transaction
      if (!db) {
        res.status(500).json({ error: 'Database not initialized' })
        return
      }
      const deleteTransaction = db.transaction((messageIds: string[]) => {
        for (const id of messageIds) {
          statements.deleteMessage.run(id)
        }
      })

      deleteTransaction(ids)
      // console.log('[LocalServer] ✅ Bulk deleted', ids.length, 'messages')
      res.json({ deleted: ids.length })
    } catch (error) {
      console.error('[LocalServer] ❌ Error bulk deleting messages:', error)
      res.status(500).json({ error: 'Failed to bulk delete messages' })
    }
  })
}
