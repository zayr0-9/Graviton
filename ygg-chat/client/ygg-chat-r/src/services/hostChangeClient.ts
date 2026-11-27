import type { QueryClient } from '@tanstack/react-query'
import { buildLocalApiUrl } from '../utils/api'
import { isHostClient } from '../platform/clientCapabilities'

import { HOST_DATA_CHANGED, type HostDataChange } from './hostChangeEvents'

/** Bounded metadata polling avoids one long-lived transport per domain. Register
 * before baseline UI fetches; every reset/reconnect invalidates the baseline. */
export function startHostChangeClient(queryClient: QueryClient): () => void {
  if (!isHostClient) return () => {}
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let epoch = ''
  let cursor = 0
  let disconnected = false
  const invalidate = (detail: HostDataChange) => {
    const domains = new Set(detail.changes?.map(change => change.domain))
    void queryClient.invalidateQueries({ predicate: query => {
      const root = String(query.queryKey[0])
      if (detail.reset) return ['conversations', 'projects', 'research-notes', 'lineages', 'transcript-revisions'].includes(root)
      if (root === 'transcript-revisions') return detail.changes?.some(change => change.domain === 'transcript_revisions' &&
        change.conversation_id === query.queryKey[1] && change.entity_id === query.queryKey[2]) ?? false
      if (domains.size === 1 && domains.has('transcript_revisions')) return false
      if (root === 'projects') return domains.has('projects')
      if (root === 'research-notes' || root === 'lineages') return domains.has('conversations') || domains.has('messages')
      if (root !== 'conversations') return false
      return query.queryKey[2] !== 'messages' || detail.conversationIds.includes(String(query.queryKey[1]))
    } })
    if (detail.reset || domains.size !== 1 || !domains.has('transcript_revisions')) {
      window.dispatchEvent(new CustomEvent(HOST_DATA_CHANGED, { detail }))
    }
  }
  const poll = async () => {
    let delay = 1000
    try {
      const url = await buildLocalApiUrl(`/host/changes?epoch=${encodeURIComponent(epoch)}&after=${cursor}`)
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error(`Host change feed unavailable (${response.status})`)
      const data = await response.json()
      if (typeof data.epoch !== 'string' || !Number.isSafeInteger(data.cursor) || !Array.isArray(data.changes)) throw new Error('Invalid change feed')
      const reset = data.reset === true || disconnected || (epoch !== '' && data.epoch !== epoch)
      if (reset || data.changes.length) {
        invalidate({ reset, changes: data.changes, conversationIds: [...new Set<string>(data.changes
          .map((change: any) => change.conversation_id).filter((id: unknown) => typeof id === 'string'))] })
      }
      epoch = data.epoch
      cursor = data.cursor
      disconnected = false
      if (data.hasMore) delay = 0
    } catch {
      disconnected = true
      delay = 3000
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(poll, delay)
    }
  }
  void poll()
  return () => { controller.abort(); if (timer) clearTimeout(timer) }
}
