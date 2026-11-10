import { buildChatErrorEnvelope, type ChatErrorEnvelope } from '../../../../../shared/chatErrors'
import { buildLocalApiUrl } from '../../utils/api'

/** A missing replay payload is not proof that execution failed. Consult only the
 * exact host-owned run ledger; renderer compatibility rows cannot prove success. */
export async function reconcileGoneRun(streamId: string, conversationId: string, signal: AbortSignal): Promise<{
  recovered?: 'completed' | 'cancelled'
  envelope?: ChatErrorEnvelope
}> {
  const detail = `GET /streams/${streamId} → 410`
  try {
    const response = await fetch(await buildLocalApiUrl(`/streaming/runs/${encodeURIComponent(streamId)}`), { signal, cache: 'no-store' })
    if (response.ok) {
      const { run } = await response.json()
      if (run?.stream_id === streamId && run.conversation_id === conversationId && run.source === 'headless') {
        if (run.status === 'completed' && run.end_reason !== 'provider_error') return { recovered: 'completed' }
        if (run.status === 'aborted' && ['aborted', 'cancelled'].includes(run.end_reason)) return { recovered: 'cancelled' }
        if (run.status === 'error' || run.status === 'aborted') return {
          envelope: buildChatErrorEnvelope('stream_interrupted', { status: 410,
            detail: `${detail}; saved run status=${run.status}, reason=${run.end_reason ?? 'unknown'}` }),
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw error
    // Missing/unreadable ledger is uncertainty, never evidence of completion.
  }
  return { envelope: buildChatErrorEnvelope('run_expired', { status: 410, detail }) }
}
