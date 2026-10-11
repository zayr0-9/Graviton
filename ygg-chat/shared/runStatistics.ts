/** Durable main-run data used only for transcript decoration. */
export interface ConversationRunStatistics {
  stream_id: string
  conversation_id: string
  lineage_id?: string | null
  stream_type: 'primary' | 'branch' | 'tool' | 'subagent'
  status: 'running' | 'completed' | 'aborted' | 'error'
  parent_message_id?: string | null
  user_message_id?: string | null
  assistant_message_id?: string | null
  final_message_id?: string | null
  started_at: string
  duration_ms: number | null
  metadata?: Record<string, any> | null
  tool_statistics?: { count: number; coverage: 'recorded' | 'partial' | 'unavailable' }
}

export interface RunMessageAttribution {
  version: 1
  streamId: string
  kind: 'model_response' | 'terminal_error'
}
