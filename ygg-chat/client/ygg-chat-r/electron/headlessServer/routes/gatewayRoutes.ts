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

/** Flat list merge (fetchConversations / useConversations): local + cloud, updated_at desc. */
export function mergeConversationLists(local: any[], cloud: any[]): any[] {
  return sortByUpdatedDesc([...(local || []), ...(cloud || [])])
}

/** Projects merge (useProjects): cloud + local, ordered by latest_conversation_updated_at || updated_at desc. */
export function mergeProjects(cloud: any[], local: any[]): any[] {
  const key = (p: any) => ts(p.latest_conversation_updated_at || p.updated_at)
  return [...(cloud || []), ...(local || [])].sort((a, b) => key(b) - key(a))
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
  const merged = sortByUpdatedDesc([...normalizedCloud, ...(local || [])])
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
    const merged = sortByUpdatedDesc([...(localAll || []), ...cloudConvs])
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
  const conversations = sortByUpdatedDesc([...(local?.conversations || []), ...(cloud?.conversations || [])])
  return {
    conversations,
    nextCursor: local?.hasMore ? local?.nextCursor ?? null : cloud?.nextCursor ?? null,
    hasMore: !!local?.hasMore || !!cloud?.hasMore,
  }
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
    const cloud = await cloudLeg('GET', `/projects`)
    const cloudArr = Array.isArray(cloud.body) ? cloud.body : cloud.body?.projects || []
    res.json(mergeProjects(cloudArr, Array.isArray(local.body) ? local.body : []))
  })

  app.get('/api/gw/projects/:id', async (req, res) => {
    const mode = localRowStorageMode('projects', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/projects/${req.params.id}`)
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('GET', `/projects/${req.params.id}`)
    res.status(r.status).json(r.body)
  })

  app.post('/api/gw/projects', async (req, res) => {
    const storageMode = req.body?.storage_mode || req.body?.storageMode
    if (storageMode === 'local' || !(await hasCloudSession())) {
      const r = await localLeg(req, `/api/app/projects`, jsonInit('POST', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('POST', `/projects`, req.body)
    if (r.ok && r.body) await mirrorBestEffort('project', r.body)
    res.status(r.status).json(r.body)
  })

  app.patch('/api/gw/projects/:id', async (req, res) => {
    const mode = localRowStorageMode('projects', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/projects/${req.params.id}`, jsonInit('PATCH', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('PUT', `/projects/${req.params.id}`, req.body)
    if (r.ok && r.body) await mirrorBestEffort('project', r.body)
    res.status(r.status).json(r.body)
  })

  app.delete('/api/gw/projects/:id', async (req, res) => {
    const mode = localRowStorageMode('projects', req.params.id)
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
    const mode = localRowStorageMode('conversations', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}`)
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('GET', `/conversations/${req.params.id}`)
    res.status(r.status).json(r.body)
  })

  app.post('/api/gw/conversations', async (req, res) => {
    const storageMode = req.body?.storage_mode || req.body?.storageMode
    if (storageMode === 'local' || !(await hasCloudSession())) {
      const r = await localLeg(req, `/api/app/conversations`, jsonInit('POST', req.body))
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('POST', `/conversations`, req.body)
    if (r.ok && r.body) await mirrorBestEffort('conversation', r.body)
    res.status(r.status).json(r.body)
  })

  app.patch('/api/gw/conversations/:id', async (req, res) => {
    const mode = localRowStorageMode('conversations', req.params.id)
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
    const mode = localRowStorageMode('conversations', req.params.id)
    if (mode === 'local') {
      const r = await localLeg(req, `/api/app/conversations/${req.params.id}`, { method: 'DELETE' })
      res.status(r.status).json(r.body)
      return
    }
    const r = await cloudLeg('DELETE', `/conversations/${req.params.id}/`)
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
}
