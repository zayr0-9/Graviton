import type { OpenAIContextUsage } from '../../../../../shared/contextUsage.js'

export type HeadlessChatOperation = 'send' | 'repeat' | 'branch' | 'edit-branch'

export interface HeadlessMessageRequest {
  operation: HeadlessChatOperation
  conversationId: string
  parentId: string | null
  messageId?: string | null
  content: string
  provider: string
  modelName: string
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  systemPrompt?: string | null
  conversationContext?: string | null
  projectContext?: string | null
  think?: boolean
  temperature?: number
  storageMode?: 'local' | 'cloud'
  selectedFiles?: any[]
  attachmentsBase64?: any[] | null
  retrigger?: boolean
  executionMode?: 'server' | 'client'
  isBranch?: boolean
  isElectron?: boolean
  imageConfig?: any
  reasoningConfig?: any
  serviceTier?: 'priority'
  promptCacheRetention?: 'in_memory' | '24h'
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, any> }>
  rootPath?: string | null
  operationMode?: 'plan' | 'execute'
  includeOperationModePrompt?: boolean
  planModeVerbosity?: 'concise' | 'normal' | 'detailed'
  streamId?: string | null
  toolTimeoutMs?: number
  autoCompactionEnabled?: boolean
  contextLength?: number
  compactionThresholdPercent?: number
  compactionProvider?: string | null
  compactionModelName?: string | null
  compactionSystemPrompt?: string | null
}

export interface HeadlessSubagentStreamRequest {
  conversationId: string
  parentMessageId: string
  toolCallId?: string | null
  /** Parent stream id, for lineage only (becomes the subagent run's parent_stream_id). */
  streamId?: string | null
  prompt: string
  systemPrompt?: string | null
  provider: string
  modelName: string
  /** Requested tool NAMES; resolved to definitions server-side. `subagent` is always excluded. */
  tools?: string[]
  maxTurns?: number
  temperature?: number
  operationMode?: 'plan' | 'execute'
  /** Parent's toolAutoApprove && inheritAutoApprove. When false, only read-only tools run. */
  autoApprove: boolean
  rootPath?: string | null
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  toolTimeoutMs?: number
  autoCompactionEnabled?: boolean
  contextLength?: number
  compactionThresholdPercent?: number
}

export type HeadlessSubagentStreamEvent =
  | HeadlessStreamEvent
  | {
      type: 'started'
      operation: 'subagent'
      subagentRunId: string
      streamId: string
      conversationId: string
      parentMessageId: string
      toolCallId?: string | null
      provider: string
      modelName: string
      maxTurns: number
      resolvedToolNames: string[]
    }
  | {
      type: 'complete'
      subagentRunId: string
      message?: any
      result: string
      stats: {
        turnsUsed: number
        maxTurns: number
        toolCallsUsed: number
        toolsExecuted: Array<{ name: string; success: boolean }>
      }
    }
  | {
      type: 'error'
      subagentRunId?: string
      error: string
      provider?: string
      status?: number
      errorType?: string
      resetAt?: number
      retryExhausted?: boolean
      aborted?: boolean
    }

export type HeadlessStreamEvent =
  | {
      type: 'started'
      operation: HeadlessChatOperation
      conversationId: string
      parentId: string | null
      provider: string
      modelName: string
      streamId?: string | null
    }
  | { type: 'user_message_persisted'; message: any }
  | { type: 'provider_routed'; provider: string; modelName: string }
  | {
      type: 'tool_loop'
      status: 'turn_started' | 'turn_completed' | 'max_turns_reached' | 'empty_turn_retry' | 'finalization_turn'
      turn: number
      maxTurns: number
      continued?: boolean
    }
  | {
      type: 'tool_execution'
      status: 'started' | 'completed' | 'failed'
      toolCallId: string
      toolName: string
      durationMs?: number
      error?: string
    }
  | { type: 'chunk'; part: 'text' | 'reasoning'; delta: string }
  | { type: 'chunk'; part: 'image'; url: string; mimeType?: string }
  | { type: 'chunk'; part: 'tool_call'; toolCall: any }
  | { type: 'chunk'; part: 'tool_result'; toolResult: any }
  | { type: 'context_usage'; usage: OpenAIContextUsage }
  | {
      type: 'context_compaction'
      status: 'threshold_reached' | 'started' | 'completed' | 'failed'
      turn: number
      reportedTokens: number
      projectedTokens: number
      effectiveTokens: number
      contextLength: number
      thresholdPercent: number
      parentMessageId?: string | null
      summaryMessage?: any
      error?: string
    }
  | { type: 'assistant_message_persisted'; message: any }
  | { type: 'complete'; message: any; providerError?: boolean }
  | {
      type: 'error'
      error: string
      provider?: string
      modelName?: string
      retryExhausted?: boolean
      status?: number
      errorType?: string
      resetAt?: number
      assistantMessage?: any
    }
