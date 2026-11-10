/**
 * /api/gw/* — the renderer's data gateway for conversations/projects/messages.
 *
 * Graviton is local-only: every route is a thin facade over the existing local
 * /api/app/* routes (called over loopback, so local behaviour stays byte-for-byte
 * identical) or over SQLite directly. The URL namespace and the renderer's canonical
 * (camelCase) request bodies are kept so callers do not need to change; this module
 * owns the camelCase → snake_case translation for the local routes.
 *
 * `?storageMode=` hints from older callers are ignored. Lineage reads under
 * /api/gw/* are mounted separately by lineageRoutes.ts.
 */

import type { Express, Request } from 'express'
import { getServerInternalOrigin } from '../../serverHost.js'
import { buildConversationMessagesTreePayload } from './appAutomationRoutes.js'

export const GW_PAGE_SIZE = 50

export interface RegisterGatewayRoutesDeps {
  /** better-sqlite3 Database. */
  db: any
  /** Shared prepared statements. */
  statements: any
  /** Test seam: overrides global fetch for the loopback local leg. */
  fetchImpl?: typeof fetch
  /** Test seam: overrides the loopback origin (defaults to the internal server origin). */
  localOrigin?: string
}

interface LegResult {
  ok: boolean
  status: number
  body: any
}

function ts(value: any): number {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

export function sortByUpdatedDesc<T extends { updated_at?: any }>(rows: T[]): T[] {
  return [...(rows || [])].sort((a, b) => ts(b.updated_at) - ts(a.updated_at))
}

// ---------------------------------------------------------------------------
// Body translation (renderer canonical camelCase → local snake_case)
// ---------------------------------------------------------------------------

const pick = (b: any, ...keys: string[]) => {
  for (const k of keys) if (b?.[k] !== undefined) return b[k]
  return undefined
}

export function toLocalConversationCreate(b: any): Record<string, any> {
  return {
    id: b?.id,
    user_id: pick(b, 'userId', 'user_id'),
    title: pick(b, 'title') ?? null,
    project_id: pick(b, 'projectId', 'project_id') ?? null,
    system_prompt: pick(b, 'systemPrompt', 'system_prompt') ?? null,
    conversation_context: pick(b, 'conversationContext', 'conversation_context') ?? null,
    cwd: pick(b, 'cwd') ?? null,
    // The column defaults to 'cloud' and list statements filter on 'local', so every
    // insert must say 'local' explicitly (fully-local plan D14).
    storage_mode: 'local',
  }
}

export function toLocalProjectCreate(b: any): Record<string, any> {
  return {
    id: b?.id,
    user_id: pick(b, 'userId', 'user_id'),
    name: pick(b, 'name') ?? 'Untitled Project',
    context: pick(b, 'context') ?? null,
    system_prompt: pick(b, 'systemPrompt', 'system_prompt') ?? null,
    cwd: pick(b, 'cwd') ?? null,
  }
}

/** Conversation sub-field → (canonical camelCase key, local snake_case column). */
export const CONVERSATION_SUBFIELDS: Record<string, { key: string; column: string }> = {
  'system-prompt': { key: 'systemPrompt', column: 'system_prompt' },
  context: { key: 'context', column: 'conversation_context' },
  'research-note': { key: 'researchNote', column: 'research_note' },
  cwd: { key: 'cwd', column: 'cwd' },
  project: { key: 'projectId', column: 'project_id' },
}

/** Drop renderer-only routing hints before forwarding a body to /api/app/*. */
function withoutStorageHints(body: any): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const { storageMode, storage_mode, ...rest } = body as Record<string, any>
  void storageMode
  void storage_mode
  return rest
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGatewayRoutes(app: Express, deps: RegisterGatewayRoutesDeps): void {
  const fetchImpl = deps.fetchImpl || fetch
  const localOrigin = (): string => deps.localOrigin || getServerInternalOrigin()

  async function localLeg(path: string, init?: RequestInit): Promise<LegResult> {
    try {
      const res = await fetchImpl(`${localOrigin()}${path}`, init)
      const text = await res.text()
      let body: any = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }
      return { ok: res.ok, status: res.status, body }
    } catch (err) {
      return { ok: false, status: 502, body: { error: 'local leg failed', detail: String(err) } }
    }
  }

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

  const forward = async (res: any, path: string, init?: RequestInit) => {
    const r = await localLeg(path, init)
    res.status(r.status).json(r.body)
  }

  const userIdOf = (req: Request) => String(req.query.userId || req.query.user_id || '')

  // ---- Projects ----

  app.get('/api/gw/projects', (req, res) => forward(res, `/api/app/projects?userId=${encodeURIComponent(userIdOf(req))}`))
  app.get('/api/gw/projects/:id', (req, res) => forward(res, `/api/app/projects/${req.params.id}`))
  app.post('/api/gw/projects', (req, res) => forward(res, `/api/app/projects`, jsonInit('POST', toLocalProjectCreate(req.body))))
  app.patch('/api/gw/projects/:id', (req, res) =>
    forward(res, `/api/app/projects/${req.params.id}`, jsonInit('PATCH', withoutStorageHints(req.body)))
  )
  app.delete('/api/gw/projects/:id', (req, res) => forward(res, `/api/app/projects/${req.params.id}`, { method: 'DELETE' }))

  // ---- Conversations: lists ----

  app.get('/api/gw/conversations', (req, res) =>
    forward(res, `/api/app/conversations?userId=${encodeURIComponent(userIdOf(req))}`)
  )

  // Real offset paging over the local list (fully-local plan Q25).
  app.get('/api/gw/conversations/paginated', (req, res) => {
    const qs = new URLSearchParams({ userId: userIdOf(req), limit: req.query.limit ? String(req.query.limit) : String(GW_PAGE_SIZE) })
    if (req.query.cursor) qs.set('cursor', String(req.query.cursor))
    return forward(res, `/api/app/conversations?${qs.toString()}`)
  })

  app.get('/api/gw/conversations/by-project', async (req, res) => {
    const projectId = String(req.query.projectId || req.query.project_id || '')
    const qs = new URLSearchParams({ userId: userIdOf(req), projectId, limit: req.query.limit ? String(req.query.limit) : String(GW_PAGE_SIZE) })
    if (req.query.cursor) qs.set('cursor', String(req.query.cursor))
    const r = await localLeg(`/api/app/conversations?${qs.toString()}`)
    res.status(r.status).json(r.body || { conversations: [], nextCursor: null, hasMore: false })
  })

  app.get('/api/gw/conversations/recent', async (req, res) => {
    const limit = Number(req.query.limit || 20)
    const r = await localLeg(`/api/app/conversations?userId=${encodeURIComponent(userIdOf(req))}`)
    if (!r.ok) {
      res.status(r.status).json(r.body)
      return
    }
    const rows = Array.isArray(r.body) ? r.body : []
    res.json(sortByUpdatedDesc(rows).slice(0, Number.isFinite(limit) && limit > 0 ? limit : rows.length))
  })

  app.get('/api/gw/conversations/favorites', (req, res) => {
    const limitQs = req.query.limit ? `&limit=${encodeURIComponent(String(req.query.limit))}` : ''
    return forward(res, `/api/app/conversations/favorites?userId=${encodeURIComponent(userIdOf(req))}${limitQs}`)
  })

  app.get('/api/gw/conversations/search', (req, res) => {
    const qs = new URLSearchParams({ userId: userIdOf(req), q: String(req.query.q || ''), limit: req.query.limit ? String(req.query.limit) : '20' })
    if (req.query.projectId) qs.set('projectId', String(req.query.projectId))
    return forward(res, `/api/app/conversations/search?${qs.toString()}`)
  })

  // ---- Conversations: single entity ----

  app.get('/api/gw/conversations/:id', (req, res) => forward(res, `/api/app/conversations/${req.params.id}`))
  app.post('/api/gw/conversations', (req, res) =>
    forward(res, `/api/app/conversations`, jsonInit('POST', toLocalConversationCreate(req.body)))
  )
  app.patch('/api/gw/conversations/:id', (req, res) =>
    forward(res, `/api/app/conversations/${req.params.id}`, jsonInit('PATCH', withoutStorageHints(req.body)))
  )
  app.delete('/api/gw/conversations/:id', (req, res) => forward(res, `/api/app/conversations/${req.params.id}`, { method: 'DELETE' }))

  app.patch('/api/gw/conversations/:id/additional-cwds', (req, res) => {
    const value = pick(req.body, 'additionalCwds', 'additional_cwds') ?? null
    return forward(res, `/api/app/conversations/${req.params.id}`, jsonInit('PATCH', { additional_cwds: value }))
  })

  // Conversation sub-field updates (system-prompt / context / research-note / cwd / project).
  for (const [seg, spec] of Object.entries(CONVERSATION_SUBFIELDS)) {
    app.patch(`/api/gw/conversations/:id/${seg}`, (req, res) => {
      const value = pick(req.body, spec.key, spec.column) ?? null
      return forward(res, `/api/app/conversations/${req.params.id}`, jsonInit('PATCH', { [spec.column]: value }))
    })
  }

  // GET the system-prompt / context sub-fields (renderer expects {systemPrompt}/{context}).
  app.get('/api/gw/conversations/:id/system-prompt', async (req, res) => {
    const r = await localLeg(`/api/app/conversations/${req.params.id}`)
    const sp = r.body && typeof r.body.system_prompt === 'string' ? r.body.system_prompt : null
    res.status(r.ok ? 200 : r.status).json(r.ok ? { systemPrompt: sp } : r.body)
  })

  app.get('/api/gw/conversations/:id/context', async (req, res) => {
    const r = await localLeg(`/api/app/conversations/${req.params.id}`)
    const ctx = r.body ? (r.body.conversation_context ?? null) : null
    res.status(r.ok ? 200 : r.status).json(r.ok ? { context: ctx } : r.body)
  })

  // ---- Messages ----

  app.get('/api/gw/conversations/:id/messages/tree', (req, res) => {
    // The hot read. Built in-process rather than via the loopback leg: the loopback
    // re-parsed and re-serialised the whole payload, which is tens of MB for a long
    // tool-heavy conversation, and the renderer refetches it on every stream end.
    try {
      res.json(buildConversationMessagesTreePayload(deps.db, deps.statements, req.params.id, req.query.includeTree !== 'false'))
    } catch (error) {
      console.error('[gateway] Error building local message tree:', error)
      res.status(500).json({ error: 'Failed to fetch message tree' })
    }
  })

  app.get('/api/gw/conversations/:id/messages', (req, res) => forward(res, `/api/app/conversations/${req.params.id}/messages`))
  app.post('/api/gw/conversations/:id/messages/bulk', (req, res) =>
    forward(res, `/api/app/conversations/${req.params.id}/messages/bulk`, jsonInit('POST', req.body))
  )

  const updateMessage = (req: Request, res: any) =>
    forward(res, `/api/app/messages/${req.params.id}`, jsonInit('PUT', withoutStorageHints(req.body)))
  app.put('/api/gw/messages/:id', updateMessage)
  app.patch('/api/gw/messages/:id', updateMessage)
  app.delete('/api/gw/messages/:id', (req, res) => forward(res, `/api/app/messages/${req.params.id}`, { method: 'DELETE' }))
  app.post('/api/gw/messages/deleteMany', (req, res) =>
    forward(res, `/api/app/messages/deleteMany`, jsonInit('POST', withoutStorageHints(req.body)))
  )

  // ---- Attachments (local SQLite) ----

  app.get('/api/gw/messages/:id/attachments', (req, res) => {
    try {
      res.json((deps.statements.getAttachmentsByMessageId.all(req.params.id) as any[]) || [])
    } catch (err) {
      res.status(500).json({ error: 'local attachments read failed', detail: String(err) })
    }
  })

  app.post('/api/gw/messages/:id/attachments', (req, res) => {
    const attachmentIds: string[] = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : []
    try {
      const now = new Date().toISOString()
      for (const attId of attachmentIds) {
        deps.statements.linkAttachment.run(`${req.params.id}:${attId}`, req.params.id, attId, now)
      }
      res.json((deps.statements.getAttachmentsByMessageId.all(req.params.id) as any[]) || [])
    } catch (err) {
      res.status(500).json({ error: 'local attachment link failed', detail: String(err) })
    }
  })

  // Removes a message's attachment associations (links only; blobs may be sha-shared).
  app.delete('/api/gw/messages/:id/attachments', (req, res) => {
    try {
      const info = deps.db?.prepare('DELETE FROM message_attachment_links WHERE message_id = ?').run(req.params.id)
      res.json({ deleted: info?.changes ?? 0 })
    } catch {
      res.json({ deleted: 0 })
    }
  })

  app.get('/api/gw/attachments/:id', (req, res) => {
    let row: any = null
    try {
      row = deps.statements.getAttachmentById?.get(req.params.id) ?? null
    } catch {
      row = null
    }
    if (!row) {
      res.status(404).json({ error: 'Attachment not found' })
      return
    }
    res.json(row)
  })
}
