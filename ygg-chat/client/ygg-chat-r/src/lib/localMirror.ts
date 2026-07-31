/**
 * localMirror — thin fire-and-forget writer to the local /api/sync/* SQLite sink.
 *
 * Phase 5 replaces the 502-line reactive dualSyncManager (queue + retry + cloud
 * abstraction) with this. Two reasons it survives the cutover:
 *  1. The legacy renderer streaming loop (still present until Phase 6 deletes it)
 *     mirrors each streamed cloud message into local SQLite.
 *  2. User rows created via the cloud proxy need a local FK stub.
 * Storage-aware CRUD no longer uses this — the /api/gw/* gateway owns that mirror
 * server-side (CloudMirrorService).
 *
 * It keeps dualSync's exact method surface (drop-in) and its behavior: skip
 * local-only records, POST/DELETE/PATCH the same /sync/* endpoints, never throw
 * (a failed local mirror must not disrupt the caller). No queue, no retry — a
 * missed mirror self-heals on the next gateway read.
 */

import { buildLocalApiUrl } from '../utils/api'

async function send(endpoint: string, method: 'POST' | 'DELETE' | 'PATCH', data?: any): Promise<void> {
  try {
    const url = await buildLocalApiUrl(endpoint)
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify(data ?? {}),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // fire-and-forget: a failed local mirror must never disrupt the caller
  }
}

async function exists(endpoint: string): Promise<boolean> {
  try {
    const url = await buildLocalApiUrl(endpoint)
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) })
    if (r.ok) {
      const d = await r.json()
      return !!d?.exists
    }
  } catch {
    // ignore
  }
  return false
}

export const localMirror = {
  syncUser: (data: any): void => {
    void send('/sync/user', 'POST', data)
  },
  syncProject: (data: any, action: 'create' | 'update' | 'delete' = 'create'): void => {
    if (data?.storage_mode === 'local') return
    if (action === 'delete') void send(`/sync/project/${data.id}`, 'DELETE')
    else void send('/sync/project', 'POST', data)
  },
  syncConversation: (data: any, action: 'create' | 'update' | 'delete' = 'create'): void => {
    if (data?.storage_mode === 'local') return
    if (action === 'delete') void send(`/sync/conversation/${data.id}`, 'DELETE')
    else void send('/sync/conversation', 'POST', data)
  },
  syncMessage: (data: any, action: 'create' | 'update' | 'delete' = 'create'): void => {
    if (data?.storage_mode === 'local') return
    if (action === 'delete') void send(`/sync/message/${data.id}`, 'DELETE')
    else void send('/sync/message', 'POST', data)
  },
  syncAttachment: (data: any): void => {
    void send('/sync/attachment', 'POST', data)
  },
  syncProviderCost: (data: any): void => {
    void send('/sync/provider-cost', 'POST', data)
  },
  syncResearchNote: (data: { id: string; researchNote: string | null }): void => {
    void send(`/conversations/${data.id}/research-note`, 'PATCH', data)
  },
  syncCwd: (data: { id: string; cwd: string | null }): void => {
    void send(`/conversations/${data.id}/cwd`, 'PATCH', data)
  },
  touchProjectTimestamp: (projectId: string): void => {
    if (!projectId) return
    void send(`/projects/${projectId}/touch`, 'PATCH', { id: projectId })
  },
  syncBatch: async (operations: Array<{ type: string; action: string; data: any }>): Promise<void> => {
    await send('/sync/batch', 'POST', { operations })
  },
  checkConversationExists: (id: string): Promise<boolean> => exists(`/sync/conversation/${id}`),
  checkProjectExists: (id: string): Promise<boolean> => exists(`/sync/project/${id}`),
  // No-op status surface retained so any legacy status readers keep type-checking.
  getStatus: () => ({ enabled: true, queueLength: 0, processing: false, errors: [] as any[], lastSyncAt: null as string | null }),
  setEnabled: (_enabled: boolean): void => {},
  refresh: async (): Promise<void> => {},
}
