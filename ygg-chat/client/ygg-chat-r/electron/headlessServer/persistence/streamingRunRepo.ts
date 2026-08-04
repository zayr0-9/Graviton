import { v4 as uuidv4 } from 'uuid'

type StreamRunStatus = 'running' | 'completed' | 'aborted' | 'error'

type UpsertStreamingRunInput = {
  streamId?: string | null
  lineageId?: string | null
  conversationId?: string | null
  parentMessageId?: string | null
  userMessageId?: string | null
  assistantMessageId?: string | null
  finalMessageId?: string | null
  streamType?: 'primary' | 'branch' | 'tool' | 'subagent'
  status?: StreamRunStatus
  endReason?: string | null
  provider?: string | null
  modelName?: string | null
  operation?: string | null
  source?: 'renderer' | 'headless' | 'subagent' | 'tool' | 'unknown'
  rootMessageId?: string | null
  originMessageId?: string | null
  parentStreamId?: string | null
  toolCallId?: string | null
  error?: string | null
  metadata?: Record<string, any> | null
}

type FinishStreamingRunInput = {
  status: Exclude<StreamRunStatus, 'running'>
  endReason?: string | null
  assistantMessageId?: string | null
  finalMessageId?: string | null
  userMessageId?: string | null
  error?: string | null
  metadata?: Record<string, any> | null
}

const metadataToJson = (metadata: Record<string, any> | null | undefined): string | null => {
  if (metadata == null) return null
  try {
    return JSON.stringify(metadata)
  } catch {
    return null
  }
}

const durationMs = (startedAt: string | null | undefined, endedAt: string | null | undefined): number | null => {
  if (!startedAt || !endedAt) return null
  const started = new Date(startedAt).getTime()
  const ended = new Date(endedAt).getTime()
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null
  return Math.max(0, ended - started)
}

export class StreamingRunRepo {
  private readonly statements: any

  constructor(deps: { statements: any }) {
    this.statements = deps.statements
  }

  upsert(input: UpsertStreamingRunInput): string {
    const streamId = input.streamId || uuidv4()
    const now = new Date().toISOString()
    const startedAt = now
    const isTerminal = input.status === 'completed' || input.status === 'aborted' || input.status === 'error'
    const endedAt = isTerminal ? now : null

    this.statements.upsertStreamingRun.run(
      streamId,
      input.conversationId ?? null,
      input.parentMessageId ?? null,
      input.userMessageId ?? null,
      input.assistantMessageId ?? null,
      input.finalMessageId ?? null,
      input.streamType ?? 'primary',
      input.status ?? 'running',
      input.endReason ?? null,
      input.provider ?? null,
      input.modelName ?? null,
      input.operation ?? null,
      input.source ?? 'headless',
      input.rootMessageId ?? input.parentMessageId ?? null,
      input.originMessageId ?? null,
      input.parentStreamId ?? null,
      input.toolCallId ?? null,
      input.error ?? null,
      metadataToJson(input.metadata),
      startedAt,
      endedAt,
      durationMs(startedAt, endedAt),
      now,
      now
    )

    if (input.lineageId) {
      if (!this.statements.attachStreamingRunToLineage) {
        throw new Error('Streaming-run lineage attachment statement is not configured')
      }
      this.statements.attachStreamingRunToLineage.run(input.lineageId, streamId)
    }

    return streamId
  }

  getLineageId(streamId: string | null | undefined): string | null {
    if (!streamId) return null
    return (this.statements.getStreamingRunById.get(streamId) as any)?.lineage_id ?? null
  }

  /**
   * The streamId of the most recent subagent stream for a tool call — what the
   * transcript viewer subscribes to for live progress. A resume mints a newer row,
   * so this always resolves the current attempt. Null when none / statement absent.
   */
  latestSubagentStreamIdByToolCall(toolCallId: string | null | undefined): string | null {
    if (!toolCallId || !this.statements.getLatestSubagentStreamIdByToolCall) return null
    return (this.statements.getLatestSubagentStreamIdByToolCall.get(toolCallId) as any)?.stream_id ?? null
  }

  finish(streamId: string | null | undefined, input: FinishStreamingRunInput): void {
    if (!streamId) return
    const existing = this.statements.getStreamingRunById.get(streamId)
    if (!existing) return
    const endedAt = new Date().toISOString()
    this.statements.updateStreamingRun.run(
      input.status,
      input.endReason ?? input.status,
      input.assistantMessageId ?? input.finalMessageId ?? null,
      input.finalMessageId ?? null,
      input.userMessageId ?? null,
      input.error ?? null,
      metadataToJson(input.metadata),
      endedAt,
      durationMs(existing.started_at, endedAt),
      endedAt,
      streamId
    )
  }
}
