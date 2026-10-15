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

/** Observed ChatGPT request throughput, not backend decoding speed. */
export interface ModelThroughput {
  version: 1
  provider: 'openaichatgpt'
  basis: 'provider_request'
  outputTokens: number
  requestDurationMs: number
  requests: number
  measuredRequests: number
  coverage: 'complete' | 'partial'
}

export interface ModelRequestMeasurement {
  durationMs: number
  /** Null means missing usage or an unsuccessful request, not reported zero. */
  outputTokens: number | null
}

export function createModelThroughput(): ModelThroughput {
  return { version: 1, provider: 'openaichatgpt', basis: 'provider_request',
    outputTokens: 0, requestDurationMs: 0, requests: 0, measuredRequests: 0, coverage: 'complete' }
}

export function recordModelRequest(total: ModelThroughput, measurement: ModelRequestMeasurement): void {
  total.requests += 1
  if (!Number.isFinite(measurement.durationMs) || measurement.durationMs <= 0 ||
      measurement.outputTokens == null || !Number.isFinite(measurement.outputTokens) || measurement.outputTokens < 0) {
    total.coverage = 'partial'
    return
  }
  total.measuredRequests += 1
  total.outputTokens += measurement.outputTokens
  total.requestDurationMs += measurement.durationMs
}

/** Old runs and incomplete measurements must never imply a precise whole-run rate. */
export function readModelThroughput(value: unknown): ModelThroughput | undefined {
  if (!value || typeof value !== 'object') return undefined
  const metric = value as ModelThroughput
  if (metric.version !== 1 || metric.provider !== 'openaichatgpt' || metric.basis !== 'provider_request' ||
      metric.coverage !== 'complete' || !Number.isInteger(metric.requests) || metric.requests <= 0 ||
      metric.measuredRequests !== metric.requests || !Number.isFinite(metric.outputTokens) || metric.outputTokens < 0 ||
      !Number.isFinite(metric.requestDurationMs) || metric.requestDurationMs <= 0 ||
      !Number.isFinite(metric.outputTokens * 1000 / metric.requestDurationMs)) return undefined
  return metric
}
