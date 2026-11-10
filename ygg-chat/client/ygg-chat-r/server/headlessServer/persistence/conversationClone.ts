import type Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { CLAUDE_TRANSFER_REFUSED, claudeTransferRefusal } from '../../../../../shared/claudeTransfer.js'
import { transferredMessageMeta } from './messageTransfer.js'

export interface ClonedConversation {
  id: string
  title: string | null
  project_id: string | null
}

export class ConversationCloneError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

const tableColumns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)

const parseIdList = (value: unknown): string[] => {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * Copies a conversation and its whole message tree in one transaction. Every message gets a new
 * id; `parent_id` and `children_ids` are remapped so sibling order is preserved. Copies start
 * without lineage rows (the lineage repo reconciles them on first use, as for transferred
 * messages), carry the same attachment links, and drop native-session metadata exactly like a
 * Heimdall transfer. A Claude branch that does not end at a committed summary is refused, because
 * the copy cannot continue that native session.
 */
export function cloneConversation(db: Database.Database, sourceConversationId: string): ClonedConversation {
  const source = db.prepare('SELECT * FROM conversations WHERE id = ?').get(sourceConversationId) as
    | Record<string, unknown>
    | undefined
  if (!source) throw new ConversationCloneError('Conversation not found', 404)

  const messages = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY COALESCE(created_at, \'\'), id')
    .all(sourceConversationId) as Array<Record<string, any>>

  const refusal = claudeTransferRefusal(
    messages.map(row => ({ ...row, id: String(row.id) })) as any,
    messages.map(row => String(row.id))
  )
  if (refusal) throw new ConversationCloneError(refusal, 409, CLAUDE_TRANSFER_REFUSED)

  const cloneId = uuidv4()
  const now = new Date().toISOString()
  const title = typeof source.title === 'string' && source.title.trim() ? `${source.title} (copy)` : 'Untitled (copy)'
  const idMap = new Map(messages.map(row => [String(row.id), uuidv4()]))

  // Parents before children, so the parent foreign key always resolves.
  const byId = new Map(messages.map(row => [String(row.id), row]))
  const ordered: Array<Record<string, any>> = []
  const visited = new Set<string>()
  for (const start of messages) {
    const chain: Array<Record<string, any>> = []
    let current: Record<string, any> | undefined = start
    while (current && !visited.has(String(current.id))) {
      visited.add(String(current.id))
      chain.push(current)
      current = current.parent_id != null ? byId.get(String(current.parent_id)) : undefined
    }
    ordered.push(...chain.reverse())
  }

  const conversationColumns = tableColumns(db, 'conversations')
  const conversationOverrides: Record<string, unknown> = {
    id: cloneId,
    title,
    storage_mode: 'local',
    created_at: now,
    updated_at: now,
    ...(conversationColumns.includes('favorite') ? { favorite: 0 } : {}),
  }
  const conversationValues = conversationColumns.map(column =>
    column in conversationOverrides ? conversationOverrides[column] : source[column]
  )

  // `revision` restarts at its default and lineage ownership is rebuilt lazily.
  const messageColumns = tableColumns(db, 'messages').filter(column => column !== 'revision' && column !== 'lineage_id')
  const insertMessage = db.prepare(
    `INSERT INTO messages (${messageColumns.join(', ')}) VALUES (${messageColumns.map(() => '?').join(', ')})`
  )
  const setChildren = db.prepare('UPDATE messages SET children_ids = ? WHERE id = ?')
  const hasLinks = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_attachment_links'").get()
  )
  const sourceLinks = hasLinks
    ? db.prepare('SELECT attachment_id, created_at FROM message_attachment_links WHERE message_id = ?')
    : null
  const insertLink = hasLinks
    ? db.prepare(
        'INSERT OR IGNORE INTO message_attachment_links (id, message_id, attachment_id, created_at) VALUES (?, ?, ?, ?)'
      )
    : null

  db.transaction(() => {
    db.prepare(
      `INSERT INTO conversations (${conversationColumns.join(', ')}) VALUES (${conversationColumns.map(() => '?').join(', ')})`
    ).run(...conversationValues)

    for (const row of ordered) {
      const sourceId = String(row.id)
      const overrides: Record<string, unknown> = {
        id: idMap.get(sourceId),
        conversation_id: cloneId,
        parent_id: row.parent_id != null ? idMap.get(String(row.parent_id)) ?? null : null,
        children_ids: '[]',
        meta: transferredMessageMeta(row.meta, sourceId, sourceConversationId, idMap),
      }
      insertMessage.run(...messageColumns.map(column => (column in overrides ? overrides[column] : row[column])))
      if (sourceLinks && insertLink) {
        for (const link of sourceLinks.all(sourceId) as Array<{ attachment_id: string; created_at: string | null }>) {
          insertLink.run(uuidv4(), idMap.get(sourceId), link.attachment_id, link.created_at ?? now)
        }
      }
    }

    // The insert trigger appends children in insertion order. Restore the source sibling order,
    // keeping parent_id authoritative: listed children first, then any the source list missed.
    const childrenByParent = new Map<string, string[]>()
    for (const row of messages) {
      if (row.parent_id == null || !idMap.has(String(row.parent_id))) continue
      const siblings = childrenByParent.get(String(row.parent_id)) ?? []
      siblings.push(String(row.id))
      childrenByParent.set(String(row.parent_id), siblings)
    }
    for (const row of messages) {
      const actual = childrenByParent.get(String(row.id)) ?? []
      const listed = parseIdList(row.children_ids).filter(id => actual.includes(id))
      const ordered = [...new Set([...listed, ...actual])]
      setChildren.run(JSON.stringify(ordered.map(id => idMap.get(id))), idMap.get(String(row.id)))
    }

    if (source.project_id != null) {
      db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, source.project_id)
    }
  })()

  return { id: cloneId, title, project_id: (source.project_id as string | null) ?? null }
}
