import type {
  HeadlessStreamEvent,
  HeadlessSubagentStreamEvent,
  HeadlessSubagentStreamRequest,
} from '../contracts/headlessApi.js'
import { SubagentRunRepo } from '../persistence/subagentRunRepo.js'
import { StreamingRunRepo } from '../persistence/streamingRunRepo.js'
import type { ProviderToolCall, ProviderToolDefinition } from '../providers/openRouterProvider.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import { ProviderRouter } from './providerRouter.js'
import type { GenerateCompactionSummaryInput } from './compactionService.js'
import { SubagentTranscriptSink } from './subagentTranscriptSink.js'
import {
  ProviderEmptyResponseError,
  ProviderErrorAssistantResponse,
  ToolLoopService,
  type ToolExecutor,
  type ToolLoopCompactor,
} from './toolLoopService.js'
import {
  assertToolAllowedWithoutAutoApprove,
  filterToolsForOperationMode,
} from '../../../../../shared/operationModeToolPolicy.js'

export interface ResolvedSubagentTools {
  tools: ProviderToolDefinition[]
  resolvedNames: string[]
  unknownNames: string[]
}

/** Minimal surface the engine needs from CompactionService (eases testing). */
export interface CompactionSummaryGenerator {
  generateCompactionSummary(input: GenerateCompactionSummaryInput): Promise<string>
}

interface SubagentRunServiceDeps {
  statements?: any
  runRepo?: SubagentRunRepo
  streamingRunRepo?: StreamingRunRepo
  tokenStore?: ProviderTokenStore
  providerRouter?: ProviderRouter
  toolExecutor: ToolExecutor
  resolveToolsByName: (names: string[] | undefined) => ResolvedSubagentTools
  compactionService: CompactionSummaryGenerator
  refreshProviderTokens?: (provider: string) => Promise<void> | void
  providerTurnTimeoutMs?: number
}

const DEFAULT_MODEL = 'gpt-5.6-sol'
const DEFAULT_MAX_TURNS = 120
const MAX_MAX_TURNS = 400
const DEFAULT_PROVIDER_TURN_TIMEOUT_MS = 180_000
const THINKING_WRAPPER_PATTERN = /<thinking>[\s\S]*?<\/thinking>\s*/gi

function stripThinkingWrapper(text: string): string {
  if (!text) return ''
  return text.replace(THINKING_WRAPPER_PATTERN, '').trim()
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as any).name === 'AbortError'
}

function clampMaxTurns(value: number | undefined): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_TURNS
  return Math.max(1, Math.min(requested, MAX_MAX_TURNS))
}

export class SubagentRunService {
  private readonly runRepo: SubagentRunRepo
  private readonly streamingRunRepo: StreamingRunRepo
  private readonly providerRouter: ProviderRouter
  private readonly toolExecutor: ToolExecutor
  private readonly resolveToolsByName: (names: string[] | undefined) => ResolvedSubagentTools
  private readonly compactionService: CompactionSummaryGenerator
  private readonly refreshProviderTokens?: (provider: string) => Promise<void> | void
  private readonly providerTurnTimeoutMs: number

  constructor(deps: SubagentRunServiceDeps) {
    this.runRepo = deps.runRepo ?? new SubagentRunRepo({ statements: deps.statements })
    this.streamingRunRepo = deps.streamingRunRepo ?? new StreamingRunRepo({ statements: deps.statements })
    this.providerRouter = deps.providerRouter ?? new ProviderRouter({ tokenStore: deps.tokenStore })
    this.toolExecutor = deps.toolExecutor
    this.resolveToolsByName = deps.resolveToolsByName
    this.compactionService = deps.compactionService
    this.refreshProviderTokens = deps.refreshProviderTokens
    this.providerTurnTimeoutMs = Math.max(5_000, deps.providerTurnTimeoutMs ?? DEFAULT_PROVIDER_TURN_TIMEOUT_MS)
  }

  /**
   * Run a subagent from another server-owned tool loop and return its final text.
   * The normal lifecycle events are still produced internally, so persistence and
   * terminal-state handling stay identical to the SSE route.
   */
  async runForTool(request: HeadlessSubagentStreamRequest, signal: AbortSignal): Promise<string> {
    let result: string | null = null
    let terminalError: string | null = null

    await this.run(
      request,
      event => {
        if (event.type === 'complete' && 'result' in event) {
          result = event.result
        } else if (event.type === 'error') {
          terminalError = event.error
        }
      },
      signal
    )

    if (signal.aborted) {
      const abortError = new Error(terminalError || 'Subagent aborted')
      abortError.name = 'AbortError'
      throw abortError
    }
    if (terminalError) throw new Error(terminalError)
    if (result === null) throw new Error('Subagent ended without a terminal result')
    return result
  }

  async run(
    request: HeadlessSubagentStreamRequest,
    emit: (event: HeadlessSubagentStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const provider =
      typeof request.provider === 'string' && request.provider.trim() ? request.provider.trim() : 'openaichatgpt'
    const modelName =
      typeof request.modelName === 'string' && request.modelName.trim() ? request.modelName.trim() : DEFAULT_MODEL
    const operationMode = request.operationMode === 'plan' ? 'plan' : 'execute'
    const maxTurns = clampMaxTurns(request.maxTurns)

    // Refresh provider auth from the Electron store in case the user signed in
    // or tokens rotated after the server started.
    try {
      await this.refreshProviderTokens?.(provider)
    } catch (error) {
      console.warn('[subagent] provider token refresh failed (continuing):', error)
    }

    const resolved = this.resolveToolsByName(request.tools)
    let tools = resolved.tools
    if (operationMode === 'plan') {
      tools = filterToolsForOperationMode(
        tools.map(tool => ({ ...tool, isMcp: tool.name.startsWith('mcp__') })),
        'plan'
      )
    }
    const resolvedToolNames = tools.map(tool => tool.name)

    const run = this.runRepo.createRun({
      conversationId: request.conversationId,
      parentMessageId: request.parentMessageId,
      toolCallId: request.toolCallId ?? null,
      prompt: request.prompt,
      provider,
      modelName,
      systemPrompt: request.systemPrompt ?? null,
      status: 'running',
    })
    const runId = run.id

    // Child streaming_runs row (never the parent's stream id) for lineage.
    const subStreamId = this.streamingRunRepo.upsert({
      conversationId: request.conversationId,
      parentMessageId: request.parentMessageId,
      streamType: 'subagent',
      source: 'subagent',
      operation: 'subagent',
      provider,
      modelName,
      toolCallId: request.toolCallId ?? null,
      parentStreamId: request.streamId ?? null,
      metadata: { subagent_run_id: runId },
    })

    emit({
      type: 'started',
      operation: 'subagent',
      subagentRunId: runId,
      streamId: subStreamId,
      conversationId: request.conversationId,
      parentMessageId: request.parentMessageId,
      toolCallId: request.toolCallId ?? null,
      provider,
      modelName,
      maxTurns,
      resolvedToolNames,
    })

    // Persist the user prompt as the first transcript row (renderer parity).
    const userMessage = this.runRepo.appendMessage(runId, {
      role: 'user',
      content: request.prompt,
      contentBlocks: [{ type: 'text', content: request.prompt, subagent_role: 'user_prompt' }],
    })

    let turnsUsed = 0
    let toolCallsUsed = 0
    const toolsExecuted: Array<{ name: string; success: boolean }> = []

    const countingExecutor: ToolExecutor = async (toolCall: ProviderToolCall, context) => {
      if (!request.autoApprove) {
        try {
          assertToolAllowedWithoutAutoApprove(toolCall)
        } catch (error) {
          toolsExecuted.push({ name: toolCall.name, success: false })
          throw error
        }
      }
      toolCallsUsed += 1
      try {
        const result = await this.toolExecutor(toolCall, { ...context, nestedExecutor: countingExecutor })
        toolsExecuted.push({ name: toolCall.name, success: true })
        return result
      } catch (error) {
        if (context.signal?.aborted || isAbortError(error)) throw error
        toolsExecuted.push({ name: toolCall.name, success: false })
        throw error
      }
    }

    const transcriptCompactor: ToolLoopCompactor = async input => {
      const summaryText = await this.compactionService.generateCompactionSummary({
        messages: input.messages,
        provider: input.provider,
        modelName: input.modelName,
        userId: input.userId,
        accessToken: input.accessToken,
        accountId: input.accountId,
        systemPrompt: input.systemPrompt,
      })
      const row = this.runRepo.appendMessage(runId, {
        role: 'system',
        content: summaryText,
        contentBlocks: [],
      })
      return {
        message: {
          ...row,
          role: 'system',
          note: '__auto_compaction_summary__',
          parent_id: input.parentMessageId,
          conversation_id: input.conversationId,
        },
      }
    }

    const loop = new ToolLoopService({
      sink: new SubagentTranscriptSink({ runRepo: this.runRepo, runId }),
      providerRouter: this.providerRouter,
      executeTool: countingExecutor,
      compactBranch: transcriptCompactor,
      providerTurnTimeoutMs: this.providerTurnTimeoutMs,
    })

    try {
      const result = await loop.run(
        {
          provider,
          modelName,
          conversationId: request.conversationId,
          assistantParentId: userMessage.id,
          history: [{ role: 'user', content: request.prompt }],
          userContent: request.prompt,
          systemPrompt: request.systemPrompt ?? null,
          temperature: request.temperature,
          reasoningConfig: request.reasoningEffort ? { effort: request.reasoningEffort } : undefined,
          userId: request.userId ?? null,
          accessToken: request.accessToken ?? null,
          accountId: request.accountId ?? null,
          tools,
          streamId: subStreamId,
          rootPath: request.rootPath ?? null,
          operationMode,
          toolTimeoutMs: request.toolTimeoutMs,
          maxTurns,
          signal,
          railwaySessionId: `subagent:${runId}`,
          allowCommentaryFallbackText: true,
          autoCompactionEnabled: request.autoCompactionEnabled ?? true,
          contextLength: request.contextLength,
          compactionThresholdPercent: request.compactionThresholdPercent,
          compactionProvider: provider,
          compactionModelName: modelName,
          robustness: { retryEmptyTurn: true, finalizeOnSilentToolEnd: true },
        },
        (event: HeadlessStreamEvent) => emit(event)
      )

      turnsUsed = result.turnsUsed
      const finalText = stripThinkingWrapper(result.finalAssistantMessage?.content ?? '')

      this.runRepo.updateRun(runId, {
        status: 'completed',
        finalResponse: finalText,
        turnsUsed,
        toolCallsUsed,
      })
      this.streamingRunRepo.finish(subStreamId, {
        status: 'completed',
        endReason: 'completed',
        metadata: { subagent_run_id: runId },
      })

      emit({
        type: 'complete',
        subagentRunId: runId,
        message: result.finalAssistantMessage,
        result: finalText,
        stats: { turnsUsed, maxTurns, toolCallsUsed, toolsExecuted },
      })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        this.runRepo.updateRun(runId, {
          status: 'aborted',
          error: 'Subagent aborted',
          turnsUsed,
          toolCallsUsed,
        })
        this.streamingRunRepo.finish(subStreamId, {
          status: 'aborted',
          endReason: 'aborted',
          error: 'Subagent aborted',
          metadata: { subagent_run_id: runId },
        })
        // The client has usually disconnected; emit best-effort.
        emit({ type: 'error', subagentRunId: runId, error: 'Subagent aborted', aborted: true })
        return
      }

      if (error instanceof ProviderErrorAssistantResponse) {
        const providerError = error.providerError
        this.runRepo.updateRun(runId, {
          status: 'error',
          error: providerError.originalMessage,
          finalResponse: providerError.message,
          turnsUsed,
          toolCallsUsed,
        })
        this.streamingRunRepo.finish(subStreamId, {
          status: 'error',
          endReason: 'provider_error',
          error: providerError.originalMessage,
          metadata: {
            subagent_run_id: runId,
            provider,
            status: providerError.status,
            errorType: providerError.errorType,
            retryExhausted: providerError.retryExhausted,
          },
        })
        emit({
          type: 'error',
          subagentRunId: runId,
          error: providerError.message,
          provider,
          status: providerError.status,
          errorType: providerError.errorType,
          resetAt: providerError.resetAt,
          retryExhausted: providerError.retryExhausted,
        })
        return
      }

      const message =
        error instanceof ProviderEmptyResponseError
          ? 'Provider returned an empty response after retry'
          : error instanceof Error
            ? error.message
            : String(error)

      this.runRepo.updateRun(runId, { status: 'error', error: message, turnsUsed, toolCallsUsed })
      this.streamingRunRepo.finish(subStreamId, {
        status: 'error',
        endReason: 'error',
        error: message,
        metadata: { subagent_run_id: runId },
      })
      emit({ type: 'error', subagentRunId: runId, error: message, provider })
    }
  }
}
