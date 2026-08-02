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
  /**
   * Interactive tool-permission policy for the server-owned loop.
   * OPTIONAL and undefined-by-default: absence == auto-approve. The loop pauses
   * for a permission decision ONLY when a caller EXPLICITLY sends `false`
   * (the mobile LAN UI never sends it, so it always auto-approves).
   */
  toolAutoApprove?: boolean
  autoCompactionEnabled?: boolean
  contextLength?: number
  compactionThresholdPercent?: number
  compactionProvider?: string | null
  compactionModelName?: string | null
  compactionSystemPrompt?: string | null
  /** Reasoning effort forwarded to child subagents spawned by this chat run. */
  subagentReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  /**
   * Phase 3 opt-in: run the 5 lifecycle chat hooks in the server loop (parity with
   * the renderer's chat hooks). Absent/false == no hooks. Requires the server to have
   * a hookRunner + decisionBroker wired. The mobile LAN UI and subagents never send it.
   */
  hooksEnabled?: boolean
  /**
   * Base URL passed to hook scripts as lookup.localApiBase so a hook can call back into
   * the local API (parity with the renderer's getCachedLocalApiBase()). Absent == null;
   * hooks still run, only callback-style hooks degrade.
   */
  localApiBase?: string | null
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
  /** OpenAI ChatGPT reasoning effort for this child run. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
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
  // ── Phase 0 foundations: additive members for the stateful thin-client loop. ──
  // Emitted only once the server owns the loop (Phase 2+). No current emitter, so
  // existing clients (mobile UI, subagent thin client) are unaffected.
  // The server pauses the loop and asks the renderer to approve a tool call.
  | {
      type: 'permission_required'
      streamId?: string | null
      toolCallId: string
      toolName: string
      toolInput: any
      turn?: number
    }
  // The server pauses the loop and asks the renderer to answer a plan_md clarify.
  | {
      type: 'clarify_required'
      streamId?: string | null
      toolCallId: string
      toolName: string
      questions: any[]
    }
  // The server pauses a Plan-mode run until the user decides whether to enter Agent mode.
  | {
      type: 'operation_mode_upgrade_required'
      streamId?: string | null
      toolCallId: string
      toolName: string
      toolInput: any
    }
  // The server asks the renderer to execute a UI/renderer-bound tool locally.
  | {
      type: 'tool_request'
      streamId?: string | null
      toolCallId: string
      toolName: string
      toolInput: any
    }
  // Relayed from Railway (cloud/free-tier inference) by the gateway proxy (Phase 4).
  | { type: 'free_generations_update'; remaining: number; isFreeTier?: boolean }
  | { type: 'generation_limit_reached'; message?: string }
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
