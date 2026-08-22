import { v4 as uuidv4 } from 'uuid'

export type LineageStatus = 'pending' | 'active' | 'archived'
export type ForkOperationStatus = 'pending' | 'materialized' | 'error'

export interface LineageRow {
  id: string
  conversation_id: string
  parent_lineage_id: string | null
  forked_from_message_id: string | null
  root_message_id: string | null
  head_message_id: string | null
  status: LineageStatus
  created_at: string
  updated_at: string
}

export interface ForkOperationRow {
  id: string
  conversation_id: string
  source_lineage_id: string | null
  target_lineage_id: string
  source_message_id: string | null
  materialized_message_id: string | null
  operation: string
  status: ForkOperationStatus
  metadata_json: string | null
  created_at: string
  updated_at: string
}

interface LineageRepoDeps {
  db: any
  statements: any
}

export interface CreateRootInput {
  id?: string
  conversationId: string
  rootMessageId?: string | null
  status?: LineageStatus
}

export interface CreatePendingForkInput {
  id?: string
  operationId?: string
  conversationId: string
  sourceLineageId?: string | null
  sourceMessageId?: string | null
  operation?: string
  metadata?: unknown
}

export interface ReconcileInput {
  conversationId: string
  lineageId?: string | null
  messageId?: string | null
}

const metadataToJson = (value: unknown): string | null => {
  if (value == null) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/**
 * Durable content-lineage repository. A lineage describes a branch of persisted
 * content; streaming/subagent runs may point at it but never define it.
 *
 * Multi-row writes are wrapped in better-sqlite3 transactions. Message
 * `parent_id` is deliberately never updated: adopting a message into a lineage
 * only fills `lineage_id` and advances lineage metadata.
 */
export class LineageRepo {
  private readonly db: any
  private readonly statements: any

  constructor(deps: LineageRepoDeps) {
    this.db = deps.db
    this.statements = deps.statements
  }

  get(lineageId: string): LineageRow | null {
    return (this.statements.getLineageById.get(lineageId) as LineageRow | undefined) ?? null
  }

  list(conversationId: string): LineageRow[] {
    return this.statements.listLineagesByConversation.all(conversationId) as LineageRow[]
  }

  /** Deterministically adopts legacy parent trees without collapsing forks. */
  reconcileLegacyConversation(conversationId: string): LineageRow[] {
    const messages = this.db.prepare(`SELECT id, parent_id, lineage_id, created_at FROM messages
      WHERE conversation_id = ? ORDER BY COALESCE(created_at, ''), id`).all(conversationId) as Array<{
      id: string; parent_id: string | null; lineage_id: string | null; created_at: string | null
    }>
    if (!messages.length) return this.list(conversationId)
    const byId = new Map(messages.map(message => [message.id, message]))
    const children = new Map<string, typeof messages>()
    for (const message of messages) {
      if (message.parent_id && byId.has(message.parent_id)) {
        const entries = children.get(message.parent_id) ?? []
        entries.push(message)
        children.set(message.parent_id, entries)
      }
    }
    const roots = messages.filter(message => !message.parent_id || !byId.has(message.parent_id))
    if (!roots.length) roots.push(messages[0])
    const existing = new Set(this.list(conversationId).map(lineage => lineage.id))
    const visited = new Set<string>()
    const now = new Date().toISOString()
    const write = this.db.transaction(() => {
      const walk = (message: typeof messages[number], inheritedId: string | null, parentLineageId: string | null, forkId: string | null, forceNew = false) => {
        if (visited.has(message.id)) return
        visited.add(message.id)
        let lineageId = forceNew ? null : (inheritedId ?? (message.lineage_id && existing.has(message.lineage_id) ? message.lineage_id : null))
        if (!lineageId) {
          lineageId = `legacy:${conversationId}:${message.id}`
          if (!this.get(lineageId)) this.statements.insertLineage.run(
            lineageId, conversationId, parentLineageId, forkId, message.id, message.id, 'active', now, now
          )
          existing.add(lineageId)
        }
        if (message.lineage_id !== lineageId) this.attachMessageOrThrow(lineageId, message.id)
        if (this.get(lineageId)?.head_message_id !== message.id) {
          this.statements.advanceLineage.run(message.id, message.id, 'active', now, lineageId)
        }
        ;(children.get(message.id) ?? []).forEach((child, index) => {
          const assignedLineageId = child.lineage_id && existing.has(child.lineage_id) ? child.lineage_id : null
          // Existing assignments are authoritative, including a valid continuation
          // created after an earlier fork. Only unassigned secondary children need a
          // deterministic legacy fork identity.
          walk(
            child,
            assignedLineageId ?? (index === 0 ? lineageId : null),
            lineageId,
            message.id,
            index > 0 && !assignedLineageId
          )
        })
      }
      const claimedRootLineages = new Set<string>()
      roots.forEach(root => {
        const candidate = root.lineage_id && !claimedRootLineages.has(root.lineage_id) ? root.lineage_id : null
        if (candidate) claimedRootLineages.add(candidate)
        walk(root, candidate, null, null)
      })
      messages.forEach(message => { if (!visited.has(message.id)) walk(message, message.lineage_id, null, null) })
    })
    write()
    return this.list(conversationId)
  }

  getDetail(conversationId: string, lineageId: string): (LineageRow & { pathMessageIds: string[]; path: any[] }) | null {
    const lineage = this.get(lineageId)
    if (!lineage || lineage.conversation_id !== conversationId) return null
    if (!lineage.head_message_id) return { ...lineage, pathMessageIds: [], path: [] }
    const path = this.db.prepare(`WITH RECURSIVE path(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM messages WHERE id = ? AND conversation_id = ? UNION ALL
        SELECT m.id, m.parent_id, path.depth + 1 FROM messages m JOIN path ON m.id = path.parent_id WHERE path.depth < 10000
      ) SELECT m.* FROM path JOIN messages m ON m.id = path.id ORDER BY path.depth DESC`
    ).all(lineage.head_message_id, conversationId) as any[]
    return { ...lineage, pathMessageIds: path.map(message => message.id), path }
  }

  listRecent(projectId: string, limit: number, userId?: string | null): any[] {
    const conversations = this.db.prepare(`SELECT id FROM conversations WHERE project_id = ? AND (? IS NULL OR user_id = ?)`
    ).all(projectId, userId ?? null, userId ?? null) as Array<{ id: string }>
    conversations.forEach(row => this.reconcileLegacyConversation(row.id))
    const rows = this.db.prepare(`SELECT l.*, c.title AS conversation_title, c.storage_mode,
        COALESCE(l.updated_at, c.updated_at, l.created_at) AS activity_at,
        (SELECT COUNT(*) FROM streaming_runs sr WHERE sr.lineage_id = l.id AND sr.status = 'running') +
        (SELECT COUNT(*) FROM subagent_runs ar WHERE ar.lineage_id = l.id AND ar.status = 'running') AS active_run_count
      FROM lineages l JOIN conversations c ON c.id = l.conversation_id
      WHERE c.project_id = ? AND (? IS NULL OR c.user_id = ?)
      ORDER BY activity_at DESC, l.id ASC LIMIT ?`).all(projectId, userId ?? null, userId ?? null, limit) as any[]
    return rows.map(row => {
      const detail = this.getDetail(row.conversation_id, row.id)
      const pathPreview = (detail?.path ?? []).slice(-4).map(message => ({
        id: message.id, role: message.role,
        content: String(message.plain_text_content ?? message.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }))
      return { conversationId: row.conversation_id, conversationTitle: row.conversation_title,
        storageMode: row.storage_mode, lineageId: row.id, headMessageId: row.head_message_id,
        parentLineageId: row.parent_lineage_id, activityAt: row.activity_at, status: row.status,
        activeRunCount: Number(row.active_run_count ?? 0), pathPreview }
    })
  }

  getForkOperation(operationId: string): ForkOperationRow | null {
    return (this.statements.getForkOperationById.get(operationId) as ForkOperationRow | undefined) ?? null
  }

  resolve(input: { lineageId?: string | null; messageId?: string | null }): LineageRow | null {
    if (input.lineageId) {
      const explicit = this.get(input.lineageId)
      if (explicit) return explicit
    }
    if (!input.messageId) return null
    const row = this.statements.resolveLineageByMessage.get(input.messageId) as LineageRow | undefined
    return row ?? null
  }

  createRoot(input: CreateRootInput): LineageRow {
    const lineageId = input.id?.trim() || uuidv4()
    const now = new Date().toISOString()
    const status = input.status ?? (input.rootMessageId ? 'active' : 'pending')

    const write = this.db.transaction(() => {
      this.statements.insertLineage.run(
        lineageId,
        input.conversationId,
        null,
        null,
        input.rootMessageId ?? null,
        input.rootMessageId ?? null,
        status,
        now,
        now
      )
      if (input.rootMessageId) this.attachMessageOrThrow(lineageId, input.rootMessageId)
    })
    write()
    return this.requireLineage(lineageId)
  }

  /** Creates a pending child lineage and its audit operation atomically. */
  createPendingFork(input: CreatePendingForkInput): { lineage: LineageRow; operation: ForkOperationRow } {
    const lineageId = input.id?.trim() || uuidv4()
    const operationId = input.operationId?.trim() || uuidv4()
    const now = new Date().toISOString()
    const source = input.sourceLineageId ? this.get(input.sourceLineageId) : null
    if (input.sourceLineageId && !source) throw new Error(`Source lineage not found: ${input.sourceLineageId}`)
    if (source && source.conversation_id !== input.conversationId) {
      throw new Error('Source lineage belongs to a different conversation')
    }

    const write = this.db.transaction(() => {
      this.statements.insertLineage.run(
        lineageId,
        input.conversationId,
        source?.id ?? null,
        input.sourceMessageId ?? source?.head_message_id ?? null,
        null,
        null,
        'pending',
        now,
        now
      )
      this.statements.insertForkOperation.run(
        operationId,
        input.conversationId,
        source?.id ?? null,
        lineageId,
        input.sourceMessageId ?? source?.head_message_id ?? null,
        null,
        input.operation ?? 'fork',
        'pending',
        metadataToJson(input.metadata),
        now,
        now
      )
    })
    write()

    return { lineage: this.requireLineage(lineageId), operation: this.requireOperation(operationId) }
  }

  fork(input: CreatePendingForkInput & { materializedMessageId?: string | null }): {
    lineage: LineageRow
    operation: ForkOperationRow
  } {
    const created = this.createPendingFork(input)
    return input.materializedMessageId
      ? this.materialize(created.operation.id, input.materializedMessageId)
      : created
  }

  materialize(operationId: string, messageId: string): { lineage: LineageRow; operation: ForkOperationRow } {
    const operation = this.requireOperation(operationId)
    if (operation.status === 'materialized') {
      if (operation.materialized_message_id !== messageId) {
        throw new Error(`Fork operation already materialized: ${operationId}`)
      }
      return { lineage: this.requireLineage(operation.target_lineage_id), operation }
    }
    if (operation.status !== 'pending') throw new Error(`Fork operation is not pending: ${operationId}`)
    const now = new Date().toISOString()
    const write = this.db.transaction(() => {
      this.attachMessageOrThrow(operation.target_lineage_id, messageId)
      this.statements.advanceLineage.run(messageId, messageId, 'active', now, operation.target_lineage_id)
      this.statements.materializeForkOperation.run(messageId, now, operationId)
    })
    write()
    return {
      lineage: this.requireLineage(operation.target_lineage_id),
      operation: this.requireOperation(operationId),
    }
  }

  appendMessage(lineageId: string, messageId: string): LineageRow {
    const lineage = this.requireLineage(lineageId)
    const now = new Date().toISOString()
    const write = this.db.transaction(() => {
      this.attachMessageOrThrow(lineageId, messageId)
      this.statements.advanceLineage.run(messageId, messageId, 'active', now, lineage.id)
    })
    write()
    return this.requireLineage(lineageId)
  }

  /**
   * Reconciles legacy rows without lineage metadata. It reuses the nearest
   * ancestor lineage when possible, otherwise creates a root, then appends the
   * requested message without changing its parent relationship.
   */
  reconcile(input: ReconcileInput): LineageRow {
    const explicit = this.resolve({ lineageId: input.lineageId, messageId: input.messageId })
    if (explicit) {
      if (explicit.conversation_id !== input.conversationId) throw new Error('Lineage belongs to a different conversation')
      if (input.messageId) return this.appendMessage(explicit.id, input.messageId)
      return explicit
    }

    if (input.lineageId) throw new Error(`Lineage not found: ${input.lineageId}`)
    if (!input.messageId) return this.createRoot({ conversationId: input.conversationId })

    const ancestor = this.statements.resolveAncestorLineageByMessage.get(input.messageId) as LineageRow | undefined
    if (ancestor) {
      if (ancestor.conversation_id !== input.conversationId) throw new Error('Ancestor lineage belongs to a different conversation')
      return this.appendMessage(ancestor.id, input.messageId)
    }
    return this.createRoot({ conversationId: input.conversationId, rootMessageId: input.messageId })
  }

  private attachMessageOrThrow(lineageId: string, messageId: string): void {
    const result = this.statements.attachMessageToLineage.run(lineageId, messageId, lineageId, lineageId)
    if (!result || Number(result.changes) !== 1) throw new Error(`Message not found: ${messageId}`)
  }

  private requireLineage(lineageId: string): LineageRow {
    const lineage = this.get(lineageId)
    if (!lineage) throw new Error(`Lineage not found: ${lineageId}`)
    return lineage
  }

  private requireOperation(operationId: string): ForkOperationRow {
    const operation = this.getForkOperation(operationId)
    if (!operation) throw new Error(`Fork operation not found: ${operationId}`)
    return operation
  }
}
