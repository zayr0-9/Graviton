/**
 * /api/gw/* — storage-aware gateway for conversations/projects/messages.
 *
 * Collapses the renderer's local-vs-cloud (shouldUseLocalApi) branching and its
 * client-side dual-fetch/merge into the server:
 *  - LOCAL leg is delegated in-process to the existing /api/app/* routes (over
 *    loopback, using the request's own host) so local behavior stays byte-for-
 *    byte identical — no re-implementation of the local CRUD.
 *  - CLOUD leg goes through RailwayClient (Bearer-injected pass-through).
 *  - Reads merge the two per the renderer's exact rules (order by updated_at
 *    desc; NO id-dedup — cloud/local are disjoint by the storage_mode partition;
 *    dual-cursor drains local before cloud). When there is no cloud session the
 *    cloud leg is skipped entirely (community/local-only), reproducing
 *    isElectronCommunityMode server-side.
 *  - Writes route by storage_mode: local → /api/app/*; cloud → Railway, then
 *    mirror the authoritative entity into SQLite via CloudMirrorService.
 *
 * Phase 5, gated behind the `gateway.crud` flag; no-op when disabled.
 */

import express from 'express'
import type { Express, Request } from 'express'
import type { RailwayClient } from '../services/railwayClient.js'
import type { CloudMirrorService, CloudEntityKind } from '../services/cloudMirrorService.js'
import type { AppAuthTokenManager } from '../services/appAuthTokenManager.js'

export const GW_PAGE_SIZE = 50

export interface RegisterGatewayRoutesDeps {
  railway: RailwayClient
  mirror: CloudMirrorService
  auth: AppAuthTokenManager
  /** better-sqlite3 Database (for storage_mode resolution). */
  db: any
  /** Shared prepared statements. */
  statements: any
  /** Master switch; false (default) keeps this a no-op. */
  enabled?: boolean
  /** Test seam: overrides global fetch for the loopback local leg. */
  fetchImpl?: typeof fetch
  /** Test seam: overrides the loopback origin (defaults to the request host). */
  localOrigin?: string
}

interface LegResult {
  ok: boolean
  status: number
  body: any
}

// ---------------------------------------------------------------------------
// Pure merge helpers (exported for unit tests — no DB / no HTTP)
// ---------------------------------------------------------------------------

function ts(value: any): number {
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : 0
}

export function sortByUpdatedDesc<T extends { updated_at?: any }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => ts(b.updated_at) - ts(a.updated_at))
}

/**
 * Drop duplicate ids, keeping the first occurrence. The renderer's client-side
 * merge relied on the storage_mode partition (an entity is local XOR cloud) and
 * did NO dedup, so a cloud entity mirrored into local SQLite could appear twice.
 * Deduping here is strictly safer: identical id ⇒ same entity (the local copy IS
 * the cloud mirror), so which copy wins doesn't matter.
 */
export function dedupById<T extends { id?: any }>(rows: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const r of rows || []) {
    const key = r?.id != null ? String(r.id) : null
    if (key != null) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(r)
  }
  return out
}

/** Flat list merge (fetchConversations / useConversations): local + cloud, updated_at desc, deduped. */
export function mergeConversationLists(local: any[], cloud: any[]): any[] {
  return dedupById(sortByUpdatedDesc([...(local || []), ...(cloud || [])]))
}

/** Projects merge (useProjects): cloud + local, ordered by latest_conversation_updated_at || updated_at desc, deduped. */
export function mergeProjects(cloud: any[], local: any[]): any[] {
  const key = (p: any) => ts(p.latest_conversation_updated_at || p.updated_at)
  return dedupById([...(cloud || []), ...(local || [])].sort((a, b) => key(b) - key(a)))
}

/**
 * Recent merge (useRecentConversations): normalize cloud rows, concat with local,
 * sort updated_at desc, slice to limit.
 */
export function mergeRecent(cloud: any[], local: any[], limit: number): any[] {
  const normalizedCloud = (cloud || []).map((c: any) => ({
    ...c,
    id: String(c.id),
    user_id: c.owner_id || String(c.user_id),
    project_id: c.project_id != null ? String(c.project_id) : null,
  }))
  const merged = dedupById(sortByUpdatedDesc([...normalizedCloud, ...(local || [])]))
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : merged.length
  return merged.slice(0, safeLimit)
}

/**
 * Paginated top-level list (useConversationsInfinite, region A). The local leg is
 * the FULL un-paginated local array, injected once on the first page; pages 2+ are
 * cloud-only.
 */
export function mergeConversationsPaginated(
  pageParam: string | undefined | null,
  localAll: any[],
  cloud: { conversations: any[]; nextCursor: string | null; hasMore: boolean },
  pageSize = GW_PAGE_SIZE
): { conversations: any[]; nextCursor: string | null; hasMore: boolean } {
  const cloudConvs = cloud?.conversations || []
  if (!pageParam) {
    const merged = dedupById(sortByUpdatedDesc([...(localAll || []), ...cloudConvs]))
    return {
      conversations: merged.slice(0, pageSize),
      nextCursor: cloud?.nextCursor ?? null,
      hasMore: !!cloud?.hasMore || merged.length > pageSize,
    }
  }
  return { conversations: cloudConvs, nextCursor: cloud?.nextCursor ?? null, hasMore: !!cloud?.hasMore }
}

/**
 * By-project paginated (useConversationsByProjectInfinite, region B). True dual-cursor:
 * both legs paginate with the same cursor; local drains first (its cursor wins while it
 * hasMore), then cloud. hasMore is the OR of both.
 */
export function mergeByProjectPaginated(
  local: { conversations: any[]; nextCursor: string | null; hasMore: boolean },
  cloud: { conversations: any[]; nextCursor: string | null; hasMore: boolean }
): { conversations: any[]; nextCursor: string | null; hasMore: boolean } {
  const conversations = dedupById(sortByUpdatedDesc([...(local?.conversations || []), ...(cloud?.conversations || [])]))
  return {
    conversations,
    nextCursor: local?.hasMore ? local?.nextCursor ?? null : cloud?.nextCursor ?? null,
    hasMore: !!local?.hasMore || !!cloud?.hasMore,
  }
}

// ---------------------------------------------------------------------------
// Write-body normalizers (canonical camelCase in → each backend's shape)
//
// The renderer sends ONE canonical (camelCase, Railway-ish) body; the gateway
// translates for the local leg. Cloud is Railway's native shape. This is where
// the local(snake)/cloud(camel) divergence is owned, so the renderer never branches.
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
    storage_mode: 'local',
  }
}

export function toCloudConversationCreate(b: any): Record<string, any> {
  return {
    userId: pick(b, 'userId', 'user_id'),
    title: pick(b, 'title') ?? null,
    projectId: pick(b, 'projectId', 'project_id') ?? null,
    systemPrompt: pick(b, 'systemPrompt', 'system_prompt'),
    conversationContext: pick(b, 'conversationContext', 'conversation_context'),
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

export function toCloudProjectCreate(b: any): Record<string, any> {
  // Projects use snake_case name/context/system_prompt on BOTH legs; only userId is camel.
  // cwd is intentionally dropped for cloud projects (matches the legacy renderer).
  return {
    userId: pick(b, 'userId', 'user_id'),
    name: pick(b, 'name'),
    context: pick(b, 'context') ?? null,
    system_prompt: pick(b, 'systemPrompt', 'system_prompt') ?? null,
  }
}

/** Strip local-only fields (cwd, storage mode) for a cloud project update (PUT). */
export function toCloudProjectUpdate(b: any): Record<string, any> {
  const { cwd, storage_mode, storageMode, ...rest } = (b || {}) as Record<string, any>
  void cwd
  void storage_mode
  void storageMode
  return rest
}

/** Conversation sub-field → (canonical camelCase key, local snake_case column, cloud sub-path). */
export const CONVERSATION_SUBFIELDS: Record<string, { key: string; column: string; cloudPath: string }> = {
  'system-prompt': { key: 'systemPrompt', column: 'system_prompt', cloudPath: 'system-prompt' },
  context: { key: 'context', column: 'conversation_context', cloudPath: 'context' },
  'research-note': { key: 'researchNote', column: 'research_note', cloudPath: 'research-note' },
  cwd: { key: 'cwd', column: 'cwd', cloudPath: 'cwd' },
  project: { key: 'projectId', column: 'project_id', cloudPath: 'project' },
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGatewayRoutes(app: Express, deps: RegisterGatewayRoutesDeps): void {
  if (!deps.enabled) return

  const fetchImpl = deps.fetchImpl || fetch

  const localOrigin = (req: Request): string => deps.localOrigin || `http://${req.get('host')}`

  async function localLeg(req: Request, path: string, init?: RequestInit): Promise<LegResult> {
    try {
      const res = await fetchImpl(`${localOrigin(req)}${path}`, init)
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

  async function cloudLeg(method: string, path: string, body?: unknown): Promise<LegResult> {
    try {
      const r = await deps.railway.passthrough({ method, path, body })
      return { ok: r.ok, status: r.status, body: r.body }
    } catch (err) {
      return { ok: false, status: 502, body: { error: 'cloud leg failed', detail: String(err) } }
    }
  }

  /** True when a cloud (Supabase) session exists; else the app is local-only (community). */
  async function hasCloudSession(): Promise<boolean> {
    try {
      const token = await deps.auth.getFreshAppToken()
      return !!token.accessToken
    } catch {
      return false
    }
  }

  /** Resolve an entity's storage_mode by looking it up locally; absent → cloud. */
  function localRowStorageMode(table: 'conversations' | 'projects', id: string): 'local' | 'cloud' | null {
    try {
      const row = deps.db?.prepare(`SELECT storage_mode FROM ${table} WHERE id = ?`).get(id) as
        | { storage_mode?: string }
        | undefined
      if (!row) return null
      return row.storage_mode === 'local' ? 'local' : 'cloud'
    } catch {
      return null
    }
  }

  /**
   * Resolve which leg a single-entity write targets. The renderer's explicit
   * ?storageMode= hint is AUTHORITATIVE (it knows the entity's mode from Redux),
   * so a cloud write can never be misrouted to the local leg by a stale/ambiguous
   * local mirror row. Falls back to the local row, then cloud.
   */
  function resolveWriteMode(table: 'conversations' | 'projects', id: string, req: Request): 'local' | 'cloud' {
    const hint = req.query?.storageMode
    if (hint === 'local') return 'local'
    if (hint === 'cloud') return 'cloud'
    return localRowStorageMode(table, id) ?? 'cloud'
  }

  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

  async function mirrorBestEffort(kind: CloudEntityKind, entity: unknown): Promise<void> {
    try {
      await deps.mirror.mirror(kind, entity)
    } catch (err) {
      console.warn(`[gateway] mirror(${kind}) failed:`, err)
    }
  }

  // ---- Projects ----

  app.get('/api/gw/projects', async (req, res) => {
    const userId = String(req.query.userId || req.query.user_id || '')
    const local = await localLeg(req, `/api/app/projects?userId=${encodeURIComponent(userId)}`)
    if (!(await hasCloudSession())) {
      res.status(local.status).json(local.body)
      return
    }
    // Use the sorted endpoint so cloud rows carry latest_conversation_updated_at (matches useProjects).
    const cloud = await cloudLeg('GET', `/projects/sorted/latest-conversation?userId=${encodeURIComponent(userId)}`)
    const cloudArr = Array.isArray(cloud.body) ? cloud.body : cloud.body?.projects || []
    res.json(mergeProjects(cloudArr, Array.isArray(local.body) ? local.body : []))
  })

  app.get('/api/gw/projects/:id', async (req, res) => {
    const mode = resolveWriteMode('projects', req.params.id, req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/projects/${req.params.id}`)
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('GET', `/projects/${req.params.id}`)
    res.status(r.status).json(r.body)
  })

  app.post('/api/gw/projects', async (req, res) => {
    const storageMode = pick(req.body, 'storageMode', 'storage_mode')
    if (storageMode === 'local' || !(await hasCloudSession())) {
      const r = await localLeg(req, `/api/app/projects`, jsonInit('POST', toLocalProjectCreate(req.body)))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('POST', `/projects`, toCloudProjectCreate(req.body))
    if (r.ok && r.body) {
      await mirrorBestEffort('project', {
        ...r.body,
        user_id: r.body.user_id || r.body.owner_id || pick(req.body, 'userId', 'user_id'),
      })
    }
    res.status(r.status).json(r.body)
  })

  app.patch('/api/gw/projects/:id', async (req, res) => {
    const mode = resolveWriteMode('projects', req.params.id, req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/projects/${req.params.id}`, jsonInit('PATCH', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('PUT', `/projects/${req.params.id}`, toCloudProjectUpdate(req.body))
    if (r.ok && r.body) await mirrorBestEffort('project', r.body)
    res.status(r.status).json(r.body)
  })

  app.delete('/api/gw/projects/:id', async (req, res) => {
    const mode = resolveWriteMode('projects', req.params.id, req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/projects/${req.params.id}`, { method: 'DELETE' })
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('DELETE', `/projects/${req.params.id}`)
    res.status(r.status).json(r.body)
  })

  // ---- Conversations: reads (merge) ----

  app.get('/api/gw/conversations', async (req, res) => {
    const userId = String(req.query.userId || req.query.user_id || '')
    const local = await localLeg(req, `/api/app/conversations?userId=${encodeURIComponent(userId)}`)
    if (!(await hasCloudSession())) {
      res.status(local.status).json(local.body)
      return
    }
    const cloud = await cloudLeg('GET', `/users/${encodeURIComponent(userId)}/conversations`)
    const cloudArr = Array.isArray(cloud.body) ? cloud.body : cloud.body?.conversations || []
    res.json(mergeConversationLists(Array.isArray(local.body) ? local.body : [], cloudArr))
  })

  app.get('/api/gw/conversations/paginated', async (req, res) => {
    const userId = String(req.query.userId || req.query.user_id || '')
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined
    const limit = req.query.limit ? String(req.query.limit) : String(GW_PAGE_SIZE)
    // Local leg: full un-paginated local list (region A injects it once on page 1).
    const local = await localLeg(req, `/api/app/conversations?userId=${encodeURIComponent(userId)}`)
    const localAll = Array.isArray(local.body) ? local.body : []
    if (!(await hasCloudSession())) {
      // Local-only: emulate a single first page.
      if (cursor) {
        res.json({ conversations: [], nextCursor: null, hasMore: false })
        return
      }
      const sorted = sortByUpdatedDesc(localAll)
      res.json({ conversations: sorted.slice(0, GW_PAGE_SIZE), nextCursor: null, hasMore: sorted.length > GW_PAGE_SIZE })
      return
    }
    const qs = new URLSearchParams({ limit })
    if (cursor) qs.set('cursor', cursor)
    const cloud = await cloudLeg('GET', `/users/${encodeURIComponent(userId)}/conversations/paginated?${qs.toString()}`)
    const cloudPage = {
      conversations: cloud.body?.conversations || [],
      nextCursor: cloud.body?.nextCursor ?? null,
      hasMore: !!cloud.body?.hasMore,
    }
    res.json(mergeConversationsPaginated(cursor, localAll, cloudPage, GW_PAGE_SIZE))
  })

  app.get('/api/gw/conversations/by-project', async (req, res) => {
    const userId = String(req.query.userId || req.query.user_id || '')
    const projectId = String(req.query.projectId || req.query.project_id || '')
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined
    const limit = req.query.limit ? String(req.query.limit) : String(GW_PAGE_SIZE)

    const localParams = new URLSearchParams({ userId, projectId, limit })
    if (cursor) localParams.set('cursor', cursor)
    const localReq = () => localLeg(req, `/api/app/conversations?${localParams.toString()}`)

    // Storage-mode short-circuit (mirrors the renderer's cached-project check).
    const projMode = localRowStorageMode('projects', projectId)
    if (projMode === 'local' || !(await hasCloudSession())) {
      const local = await localReq()
      res.status(local.status).json(local.body || { conversations: [], nextCursor: null, hasMore: false })
      return
    }

    const cloudQs = new URLSearchParams({ limit })
    if (cursor) cloudQs.set('cursor', cursor)
    const cloudReq = () => cloudLeg('GET', `/conversations/project/${encodeURIComponent(projectId)}/paginated?${cloudQs.toString()}`)

    if (projMode === 'cloud') {
      const cloud = await cloudReq()
      res.status(cloud.status).json(cloud.body || { conversations: [], nextCursor: null, hasMore: false })
      return
    }

    const [local, cloud] = await Promise.all([localReq(), cloudReq()])
    const localPage = {
      conversations: local.body?.conversations || [],
      nextCursor: local.body?.nextCursor ?? null,
      hasMore: !!local.body?.hasMore,
    }
    const cloudPage = {
      conversations: cloud.body?.conversations || [],
      nextCursor: cloud.body?.nextCursor ?? null,
      hasMore: !!cloud.body?.hasMore,
    }
    res.json(mergeByProjectPaginated(localPage, cloudPage))
  })

  app.get('/api/gw/conversations/recent', async (req, res) => {
    const userId = String(req.query.userId || req.query.user_id || '')
    const limit = Number(req.query.limit || 20)
    const local = await localLeg(req, `/api/app/conversations?userId=${encodeURIComponent(userId)}`)
    const localArr = Array.isArray(local.body) ? local.body : []
    if (!(await hasCloudSession())) {
      res.json(sortByUpdatedDesc(localArr).slice(0, Number.isFinite(limit) && limit > 0 ? limit : localArr.length))
      return
    }
    const cloud = await cloudLeg('GET', `/users/${encodeURIComponent(userId)}/conversations/recent?limit=${limit}`)
    const cloudArr = Array.isArray(cloud.body) ? cloud.body : cloud.body?.conversations || []
    res.json(mergeRecent(cloudArr, localArr, limit))
  })

  app.get('/api/gw/conversations/favorites', async (req, res) => {
    const userId = String(req.query.userId || req.query.user_id || '')
    const limitQs = req.query.limit ? `&limit=${encodeURIComponent(String(req.query.limit))}` : ''
    const local = await localLeg(req, `/api/app/conversations/favorites?userId=${encodeURIComponent(userId)}${limitQs}`)
    const localArr = Array.isArray(local.body) ? local.body : []
    if (!(await hasCloudSession())) {
      res.json(localArr)
      return
    }
    const cloud = await cloudLeg('GET', `/users/${encodeURIComponent(userId)}/conversations/favorites${limitQs ? `?limit=${encodeURIComponent(String(req.query.limit))}` : ''}`)
    const cloudArr = Array.isArray(cloud.body) ? cloud.body : cloud.body?.conversations || []
    res.json(mergeConversationLists(localArr, cloudArr))
  })

  app.get('/api/gw/conversations/search', async (req, res) => {
    const userId = String(req.query.userId || req.query.user_id || '')
    const q = String(req.query.q || '')
    const projectId = req.query.projectId ? String(req.query.projectId) : undefined
    const limit = req.query.limit ? String(req.query.limit) : '20'
    const localQs = new URLSearchParams({ userId, q, limit })
    if (projectId) localQs.set('projectId', projectId)
    const local = await localLeg(req, `/api/app/conversations/search?${localQs.toString()}`)
    const localArr = Array.isArray(local.body) ? local.body : []
    if (!(await hasCloudSession())) {
      res.json(localArr)
      return
    }
    const cloudPath = projectId
      ? `/conversations/search/project?userId=${encodeURIComponent(userId)}&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=${limit}`
      : `/conversations/search?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent(q)}&limit=${limit}`
    const cloud = await cloudLeg('GET', cloudPath)
    const cloudArr = Array.isArray(cloud.body) ? cloud.body : cloud.body?.conversations || []
    res.json(mergeConversationLists(localArr, cloudArr))
  })

  // ---- Conversations: single-entity reads / writes ----

  app.get('/api/gw/conversations/:id', async (req, res) => {
    const mode = resolveWriteMode('conversations', req.params.id, req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}`)
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('GET', `/conversations/${req.params.id}`)
    res.status(r.status).json(r.body)
  })

  app.post('/api/gw/conversations', async (req, res) => {
    const storageMode = pick(req.body, 'storageMode', 'storage_mode')
    if (storageMode === 'local' || !(await hasCloudSession())) {
      const r = await localLeg(req, `/api/app/conversations`, jsonInit('POST', toLocalConversationCreate(req.body)))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('POST', `/conversations`, toCloudConversationCreate(req.body))
    if (r.ok && r.body) {
      await mirrorBestEffort('conversation', {
        ...r.body,
        user_id: r.body.user_id || r.body.owner_id || pick(req.body, 'userId', 'user_id'),
        project_id: r.body.project_id ?? pick(req.body, 'projectId', 'project_id') ?? null,
      })
    }
    res.status(r.status).json(r.body)
  })

  app.patch('/api/gw/conversations/:id', async (req, res) => {
    const mode = resolveWriteMode('conversations', req.params.id, req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}`, jsonInit('PATCH', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('PATCH', `/conversations/${req.params.id}/`, req.body)
    if (r.ok && r.body) await mirrorBestEffort('conversation', r.body)
    res.status(r.status).json(r.body)
  })

  app.delete('/api/gw/conversations/:id', async (req, res) => {
    const mode = resolveWriteMode('conversations', req.params.id, req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}`, { method: 'DELETE' })
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('DELETE', `/conversations/${req.params.id}/`)
    res.status(r.status).json(r.body)
  })

  // Conversation sub-field updates (system-prompt / context / research-note / cwd / project).
  // Cloud uses per-field endpoints + camelCase; local uses one patch endpoint + snake_case.
  // Cloud path is authoritative; the local mirror row is refreshed best-effort.
  for (const [seg, spec] of Object.entries(CONVERSATION_SUBFIELDS)) {
    app.patch(`/api/gw/conversations/:id/${seg}`, async (req, res) => {
      const value = pick(req.body, spec.key, spec.column) ?? null
      const mode = resolveWriteMode('conversations', req.params.id, req)
      if (mode === 'local') {
        const r = await localLeg(req, `/api/app/conversations/${req.params.id}`, jsonInit('PATCH', { [spec.column]: value }))
        res.status(r.status).json(r.body)
        return
      }
      const r = await cloudLeg('PATCH', `/conversations/${req.params.id}/${spec.cloudPath}`, { [spec.key]: value })
      // Keep the local mirror row fresh (best-effort; matches dualSync.syncResearchNote/syncCwd).
      if (r.ok) await localLeg(req, `/api/app/conversations/${req.params.id}`, jsonInit('PATCH', { [spec.column]: value })).catch(() => {})
      res.status(r.status).json(r.body)
    })
  }

  // GET the system-prompt / context sub-fields (renderer expects {systemPrompt}/{context}).
  app.get('/api/gw/conversations/:id/system-prompt', async (req, res) => {
    const mode = localRowStorageMode('conversations', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}`)
      const sp = r.body && typeof r.body.system_prompt === 'string' ? r.body.system_prompt : null
      res.status(r.ok ? 200 : r.status).json(r.ok ? { systemPrompt: sp } : r.body)
      return
    }
    const r = await cloudLeg('GET', `/conversations/${req.params.id}/system-prompt`)
    res.status(r.status).json(r.body)
  })

  app.get('/api/gw/conversations/:id/context', async (req, res) => {
    const mode = localRowStorageMode('conversations', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}`)
      const ctx = r.body ? (r.body.conversation_context ?? null) : null
      res.status(r.ok ? 200 : r.status).json(r.ok ? { context: ctx } : r.body)
      return
    }
    const r = await cloudLeg('GET', `/conversations/${req.params.id}/context`)
    res.status(r.status).json(r.body)
  })

  // ---- Messages ----

  app.get('/api/gw/conversations/:id/messages/tree', async (req, res) => {
    const mode = localRowStorageMode('conversations', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}/messages/tree`)
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('GET', `/conversations/${req.params.id}/messages/tree`)
    res.status(r.status).json(r.body)
  })

  app.get('/api/gw/conversations/:id/messages', async (req, res) => {
    const mode = localRowStorageMode('conversations', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}/messages`)
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('GET', `/conversations/${req.params.id}/messages`)
    res.status(r.status).json(r.body)
  })

  app.post('/api/gw/conversations/:id/messages/bulk', async (req, res) => {
    const mode = localRowStorageMode('conversations', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}/messages/bulk`, jsonInit('POST', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('POST', `/conversations/${req.params.id}/messages/bulk`, req.body)
    if (r.ok && Array.isArray(r.body?.messages)) {
      for (const m of r.body.messages) await mirrorBestEffort('message', m)
    }
    res.status(r.status).json(r.body)
  })

  // messageId writes: storage resolved from the parent conversation when known,
  // else the renderer-supplied storageMode (query/body), else cloud.
  async function messageStorageMode(req: Request): Promise<'local' | 'cloud'> {
    const conversationId = String(req.query.conversationId || req.body?.conversationId || req.body?.conversation_id || '')
    if (conversationId) {
      const mode = localRowStorageMode('conversations', conversationId)
      if (mode) return mode
    }
    const explicit = req.query.storageMode || req.body?.storageMode || req.body?.storage_mode
    if (explicit === 'local') return 'local'
    return (await hasCloudSession()) ? 'cloud' : 'local'
  }

  const updateMessage = async (req: Request, res: any) => {
    const mode = await messageStorageMode(req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/messages/${req.params.id}`, jsonInit('PUT', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('PUT', `/messages/${req.params.id}`, req.body)
    if (r.ok && r.body) await mirrorBestEffort('message', r.body)
    res.status(r.status).json(r.body)
  }
  app.put('/api/gw/messages/:id', updateMessage)
  app.patch('/api/gw/messages/:id', updateMessage)

  app.delete('/api/gw/messages/:id', async (req, res) => {
    const mode = await messageStorageMode(req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/messages/${req.params.id}`, { method: 'DELETE' })
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('DELETE', `/messages/${req.params.id}`)
    res.status(r.status).json(r.body)
  })

  app.post('/api/gw/messages/deleteMany', async (req, res) => {
    const mode = await messageStorageMode(req)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/messages/deleteMany`, jsonInit('POST', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('POST', `/messages/deleteMany`, req.body)
    res.status(r.status).json(r.body)
  })

  // ---- Attachments (storage-aware; authority follows the message's conversation) ----

  /**
   * Storage mode for an attachment op keyed by MESSAGE id: the renderer's
   * ?storageMode= hint wins, else the parent conversation's storage_mode (the
   * message row is mirrored into local SQLite for cloud convs too, so the join
   * resolves in both modes), else cloud. Local reads go straight to SQLite via
   * the shared statements; cloud reads/writes go through Railway + mirror.
   */
  function attachmentMessageMode(messageId: string, req: Request): 'local' | 'cloud' {
    const hint = req.query?.storageMode
    if (hint === 'local') return 'local'
    if (hint === 'cloud') return 'cloud'
    try {
      const row = deps.db
        ?.prepare(
          'SELECT c.storage_mode AS storage_mode FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?'
        )
        .get(messageId) as { storage_mode?: string } | undefined
      if (row) return row.storage_mode === 'local' ? 'local' : 'cloud'
    } catch {
      /* fall through to cloud */
    }
    return 'cloud'
  }

  /** Remove a message's attachment associations locally (links only; blobs may be sha-shared). */
  function deleteLocalAttachmentLinks(messageId: string): number {
    try {
      const info = deps.db?.prepare('DELETE FROM message_attachment_links WHERE message_id = ?').run(messageId)
      return info?.changes ?? 0
    } catch {
      return 0
    }
  }

  app.get('/api/gw/messages/:id/attachments', async (req, res) => {
    const mode = attachmentMessageMode(req.params.id, req)
    if (mode === 'local') {
      try {
        res.json((deps.statements.getAttachmentsByMessageId.all(req.params.id) as any[]) || [])
      } catch (err) {
        res.status(500).json({ error: 'local attachments read failed', detail: String(err) })
      }
      return
    }
    const r = await cloudLeg('GET', `/messages/${encodeURIComponent(req.params.id)}/attachments`)
    res.status(r.status).json(r.body)
  })

  app.post('/api/gw/messages/:id/attachments', async (req, res) => {
    const mode = attachmentMessageMode(req.params.id, req)
    const attachmentIds: string[] = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : []
    if (mode === 'local') {
      try {
        const now = new Date().toISOString()
        for (const attId of attachmentIds) {
          deps.statements.linkAttachment.run(`${req.params.id}:${attId}`, req.params.id, attId, now)
        }
        res.json((deps.statements.getAttachmentsByMessageId.all(req.params.id) as any[]) || [])
      } catch (err) {
        res.status(500).json({ error: 'local attachment link failed', detail: String(err) })
      }
      return
    }
    const r = await cloudLeg('POST', `/messages/${encodeURIComponent(req.params.id)}/attachments`, { attachmentIds })
    if (r.ok && Array.isArray(r.body)) {
      for (const att of r.body) await mirrorBestEffort('attachment', att)
    }
    res.status(r.status).json(r.body)
  })

  app.delete('/api/gw/messages/:id/attachments', async (req, res) => {
    const mode = attachmentMessageMode(req.params.id, req)
    if (mode === 'local') {
      res.json({ deleted: deleteLocalAttachmentLinks(req.params.id) })
      return
    }
    const r = await cloudLeg('DELETE', `/messages/${encodeURIComponent(req.params.id)}/attachments`)
    res.status(r.status).json(r.body)
  })

  app.get('/api/gw/attachments/:id', async (req, res) => {
    const hint = req.query?.storageMode
    let localRow: any = null
    if (hint !== 'cloud') {
      try {
        localRow = deps.statements.getAttachmentById?.get(req.params.id) ?? null
      } catch {
        localRow = null
      }
    }
    if (hint === 'local' || (hint !== 'cloud' && localRow)) {
      res.json(localRow)
      return
    }
    const r = await cloudLeg('GET', `/attachments/${encodeURIComponent(req.params.id)}`)
    res.status(r.status).json(r.body)
  })

  // Upload: cloud-only (local attachments use the base64 prepare/save path, not
  // multipart). Forward the raw multipart body to Railway verbatim so the boundary
  // header stays intact, then mirror + link the returned attachment into SQLite.
  app.post('/api/gw/attachments', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    const messageId = req.query?.messageId ? String(req.query.messageId) : undefined
    const contentType = req.get('content-type') || 'application/octet-stream'
    const bodyBuf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from((req.body as any) || [])
    try {
      const r = await deps.railway.passthrough({
        method: 'POST',
        path: `/attachments`,
        headers: { 'Content-Type': contentType },
        body: bodyBuf,
      })
      if (r.ok && r.body && typeof r.body === 'object') {
        const att = r.body as Record<string, any>
        const linkMessageId = att.message_id ?? messageId ?? null
        await mirrorBestEffort('attachment', { ...att, message_id: linkMessageId })
        if (linkMessageId && att.id) {
          try {
            deps.statements.linkAttachment.run(
              `${linkMessageId}:${att.id}`,
              linkMessageId,
              att.id,
              new Date().toISOString()
            )
          } catch {
            /* best-effort local link */
          }
        }
      }
      res.status(r.status).json(r.body)
    } catch (err) {
      res.status(502).json({ error: 'attachment upload failed', detail: String(err) })
    }
  })
}
