/**
 * CloudMirrorService — server-side replacement for the renderer's reactive
 * dualSyncManager: mirrors Railway-authoritative cloud entities into local
 * SQLite (adopting their ids) so the renderer talks only to the local server.
 *
 * Phase 5: real, in-process implementation. It reuses the SAME prepared
 * statements the /api/sync/* HTTP sink uses (passed in from localServer.ts),
 * and replicates that sink's exact column mapping — owner_id→user_id, default
 * fallbacks, JSON stringification — plus the ensure*Exists FK-stub creation.
 * No HTTP hop: the gateway and the sink share one process + one db.
 *
 * Note: the /api/sync/message generated-image local-save side-effect is
 * intentionally NOT reproduced here. Generated images arrive on the streaming
 * path (persisted by the CloudMirrorSink in the chat loop), not through the
 * CRUD gateway, so the mirror only needs the row upsert.
 */

export type CloudEntityKind =
  | 'user'
  | 'project'
  | 'conversation'
  | 'message'
  | 'attachment'
  | 'provider-cost'

export interface CloudMirrorService {
  /** Upsert a Railway-returned entity into local SQLite (adopting its id). */
  mirror(kind: CloudEntityKind, entity: unknown): Promise<void>
}

export interface CloudMirrorServiceDeps {
  /** better-sqlite3 Database (shared with localServer.ts). */
  db: any
  /** Shared prepared statements (upsertUser/Project/Conversation/Message/Attachment/ProviderCost, getAttachmentBySha256). */
  statements: any
}

function nowIso(): string {
  return new Date().toISOString()
}

class SqliteCloudMirrorService implements CloudMirrorService {
  private readonly db: any
  private readonly statements: any

  constructor(deps: CloudMirrorServiceDeps) {
    this.db = deps.db
    this.statements = deps.statements
  }

  async mirror(kind: CloudEntityKind, entity: unknown): Promise<void> {
    const e = (entity ?? {}) as Record<string, any>
    switch (kind) {
      case 'user':
        return this.mirrorUser(e)
      case 'project':
        return this.mirrorProject(e)
      case 'conversation':
        return this.mirrorConversation(e)
      case 'message':
        return this.mirrorMessage(e)
      case 'attachment':
        return this.mirrorAttachment(e)
      case 'provider-cost':
        return this.mirrorProviderCost(e)
      default:
        return
    }
  }

  // ---- FK-stub helpers (mirror localServer.ts ensure*Exists) ----

  private ensureUserExists(userId: string): void {
    if (!this.db || !userId) return
    const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
    if (!existing) {
      this.db
        .prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)')
        .run(userId, `synced-user-${String(userId).substring(0, 8)}`, nowIso())
    }
  }

  private ensureProjectExists(projectId: string, userId: string): void {
    if (!this.db || !projectId) return
    this.ensureUserExists(userId)
    const existing = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
    if (!existing) {
      const now = nowIso()
      this.db
        .prepare(
          'INSERT INTO projects (id, name, user_id, context, system_prompt, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(projectId, 'Synced Project', userId, null, null, null, now, now)
    }
  }

  private ensureConversationExists(conversationId: string, userId: string, projectId?: string | null): void {
    if (!this.db || !conversationId) return
    this.ensureUserExists(userId)
    if (projectId) this.ensureProjectExists(projectId, userId)
    const existing = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)
    if (!existing) {
      const now = nowIso()
      this.db
        .prepare(
          'INSERT INTO conversations (id, project_id, user_id, title, model_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(conversationId, projectId || null, userId, 'Synced Conversation', 'unknown', now, now)
    }
  }

  // ---- Entity mirrors (mirror the /api/sync/* handler bodies) ----

  private mirrorUser(e: Record<string, any>): void {
    if (!e.id) return
    this.statements.upsertUser.run(e.id, e.username || `synced-user-${String(e.id).substring(0, 8)}`, e.created_at || nowIso())
  }

  private mirrorProject(e: Record<string, any>): void {
    const effectiveUserId = e.user_id || e.owner_id
    if (!e.id || !effectiveUserId) return
    this.ensureUserExists(effectiveUserId)
    this.statements.upsertProject.run(
      e.id,
      e.name,
      effectiveUserId,
      e.context || null,
      e.system_prompt || null,
      e.cwd || null,
      e.storage_mode || 'cloud',
      e.created_at || nowIso(),
      e.updated_at || nowIso()
    )
  }

  private mirrorConversation(e: Record<string, any>): void {
    const effectiveUserId = e.user_id || e.owner_id
    if (!e.id || !effectiveUserId) return
    this.ensureUserExists(effectiveUserId)
    if (e.project_id) this.ensureProjectExists(e.project_id, effectiveUserId)
    this.statements.upsertConversation.run(
      e.id,
      e.project_id || null,
      effectiveUserId,
      e.title || null,
      e.model_name || 'unknown',
      e.system_prompt || null,
      e.conversation_context || null,
      e.research_note || null,
      e.cwd || null,
      e.storage_mode || 'cloud',
      e.created_at || nowIso(),
      e.updated_at || nowIso()
    )
  }

  private mirrorMessage(e: Record<string, any>): void {
    if (!e.id || !e.conversation_id) return

    // Resolve user/project context for the FK stub, falling back to the existing conversation row.
    let effectiveUserId = e.user_id || e.owner_id
    let effectiveProjectId = e.project_id
    if (!effectiveUserId && this.db) {
      const existingConv = this.db
        .prepare('SELECT user_id, project_id FROM conversations WHERE id = ?')
        .get(e.conversation_id) as { user_id: string; project_id: string | null } | undefined
      if (existingConv) {
        effectiveUserId = existingConv.user_id
        effectiveProjectId = effectiveProjectId || existingConv.project_id
      }
    }
    if (effectiveUserId) {
      this.ensureConversationExists(e.conversation_id, effectiveUserId, effectiveProjectId || null)
    }

    const messageCreatedAt = e.created_at || nowIso()
    const normalizedContentBlocks =
      typeof e.content_blocks === 'string' ? e.content_blocks : JSON.stringify(e.content_blocks || null)

    this.statements.upsertMessage.run(
      e.id,
      e.conversation_id,
      e.parent_id || null,
      typeof e.children_ids === 'string' ? e.children_ids : JSON.stringify(e.children_ids || []),
      e.role,
      e.content,
      e.plain_text_content || null,
      e.thinking_block || null,
      typeof e.tool_calls === 'string' ? e.tool_calls : JSON.stringify(e.tool_calls || null),
      e.tool_call_id || null,
      e.model_name || 'unknown',
      e.note || null,
      e.note_color || null,
      e.ex_agent_session_id || null,
      e.ex_agent_type || null,
      normalizedContentBlocks,
      messageCreatedAt
    )

    // Touch conversation/project timestamps to reflect recent activity.
    if (this.db) {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(messageCreatedAt, e.conversation_id)
      let projectIdToTouch = effectiveProjectId
      if (!projectIdToTouch) {
        const row = this.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(e.conversation_id) as
          | { project_id: string | null }
          | undefined
        projectIdToTouch = row?.project_id || null
      }
      if (projectIdToTouch) {
        this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(messageCreatedAt, projectIdToTouch)
      }
    }
  }

  private mirrorAttachment(e: Record<string, any>): void {
    if (!e.id) return
    // sha256 dedup: reuse an existing row with matching content, else upsert.
    if (e.sha256) {
      const existing = this.statements.getAttachmentBySha256?.get(e.sha256) as { id: string } | undefined
      if (existing && existing.id !== e.id) return // content already mirrored under a different id
    }
    this.statements.upsertAttachment.run(
      e.id,
      e.message_id || null,
      e.kind,
      e.mime_type,
      e.storage || 'url',
      e.url || null,
      e.file_path || null,
      e.width || null,
      e.height || null,
      e.size_bytes || null,
      e.sha256 || null,
      e.created_at || nowIso(),
      null
    )
  }

  private mirrorProviderCost(e: Record<string, any>): void {
    if (!e.id) return
    this.statements.upsertProviderCost.run(
      e.id,
      e.user_id,
      e.message_id,
      e.prompt_tokens || 0,
      e.completion_tokens || 0,
      e.reasoning_tokens || 0,
      e.approx_cost || 0,
      e.api_credit_cost || 0,
      e.created_at || nowIso()
    )
  }
}

/** Factory for the real SQLite-mirroring service. */
export function createCloudMirrorService(deps: CloudMirrorServiceDeps): CloudMirrorService {
  return new SqliteCloudMirrorService(deps)
}
