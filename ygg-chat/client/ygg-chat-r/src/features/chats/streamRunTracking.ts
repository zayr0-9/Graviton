import { ConversationId, MessageId } from '../../../../../shared/types'
import { localApi } from '../../utils/api'
import { StreamLineage, StreamType } from './chatTypes'

type StreamRunSource = 'renderer' | 'headless' | 'subagent' | 'tool' | 'unknown'
type StreamRunStatus = 'running' | 'completed' | 'aborted' | 'error'
type StreamRunEndReason = 'completed' | 'aborted' | 'error' | 'context_compaction_failed' | 'pruned' | 'unknown'

const isLocalRuntime = (): boolean =>
  import.meta.env.VITE_ENVIRONMENT === 'electron' ||
  import.meta.env.VITE_ENVIRONMENT === 'local' ||
  (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__)

export interface CreateStreamingRunInput {
  streamId: string
  conversationId?: ConversationId | string | null
  parentMessageId?: MessageId | string | null
  userMessageId?: MessageId | string | null
  assistantMessageId?: MessageId | string | null
  finalMessageId?: MessageId | string | null
  streamType?: StreamType
  provider?: string | null
  modelName?: string | null
  operation?: string | null
  source?: StreamRunSource
  lineage?: StreamLineage | null
  parentStreamId?: string | null
  toolCallId?: string | null
  metadata?: Record<string, any> | null
}

export interface FinishStreamingRunInput {
  status: Exclude<StreamRunStatus, 'running'>
  endReason?: StreamRunEndReason
  assistantMessageId?: MessageId | string | null
  finalMessageId?: MessageId | string | null
  userMessageId?: MessageId | string | null
  error?: string | null
  metadata?: Record<string, any> | null
}

export const createStreamingRun = async (input: CreateStreamingRunInput): Promise<void> => {
  if (!isLocalRuntime() || !input.streamId) return
  try {
    await localApi.post('/streaming/runs', {
      stream_id: input.streamId,
      conversation_id: input.conversationId ?? null,
      parent_message_id: input.parentMessageId ?? input.lineage?.rootMessageId ?? null,
      user_message_id: input.userMessageId ?? null,
      assistant_message_id: input.assistantMessageId ?? null,
      final_message_id: input.finalMessageId ?? null,
      stream_type: input.streamType ?? 'primary',
      status: 'running',
      provider: input.provider ?? null,
      model_name: input.modelName ?? null,
      operation: input.operation ?? null,
      source: input.source ?? 'renderer',
      root_message_id: input.lineage?.rootMessageId ?? input.parentMessageId ?? null,
      origin_message_id: input.lineage?.originMessageId ?? null,
      parent_stream_id: input.parentStreamId ?? input.lineage?.parentStreamId ?? null,
      tool_call_id: input.toolCallId ?? null,
      metadata: input.metadata ?? null,
    })
  } catch (error) {
    console.warn('[streamRunTracking] Failed to create streaming run:', error)
  }
}

export const finishStreamingRun = async (streamId: string | null | undefined, input: FinishStreamingRunInput): Promise<void> => {
  if (!isLocalRuntime() || !streamId) return
  try {
    await localApi.patch(`/streaming/runs/${encodeURIComponent(streamId)}`, {
      status: input.status,
      end_reason: input.endReason ?? input.status,
      assistant_message_id: input.assistantMessageId ?? input.finalMessageId ?? null,
      final_message_id: input.finalMessageId ?? null,
      user_message_id: input.userMessageId ?? null,
      error: input.error ?? null,
      metadata: input.metadata ?? null,
    })
  } catch (error) {
    console.warn('[streamRunTracking] Failed to finish streaming run:', error)
  }
}
