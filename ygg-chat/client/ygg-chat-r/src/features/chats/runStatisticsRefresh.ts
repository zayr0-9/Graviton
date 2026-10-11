import type { QueryClient } from '@tanstack/react-query'
import type { ConversationRunStatistics } from '../../../../../shared/runStatistics'
import { conversationQueryKeys } from './conversationQueryKeys'

const pending = new Map<string, Promise<void>>()

/** Coalesce complete/sendingCompleted/abort notifications for the same run. */
export function refreshRunStatistics(
  queryClient: QueryClient | null,
  conversationId: string,
  streamId: string,
  wait: (ms: number) => Promise<unknown> = ms => new Promise(resolve => setTimeout(resolve, ms))
): Promise<void> {
  if (!queryClient) return Promise.resolve()
  const identity = `${conversationId}:${streamId}`
  const existing = pending.get(identity)
  if (existing) return existing
  const key = conversationQueryKeys.runStatistics(conversationId)
  const task = (async () => {
    try {
      for (const delay of [0, 300, 1200]) {
        if (delay) await wait(delay)
        await queryClient.invalidateQueries({ queryKey: key })
        const runs = queryClient.getQueryData<ConversationRunStatistics[]>(key)
        if (runs?.some(run => run.stream_id === streamId && run.status !== 'running')) break
      }
    } catch {
      // Decoration reads are best-effort; reconnect/remount can fetch again.
    }
  })()
  pending.set(identity, task)
  void task.finally(() => { if (pending.get(identity) === task) pending.delete(identity) })
  return task
}
