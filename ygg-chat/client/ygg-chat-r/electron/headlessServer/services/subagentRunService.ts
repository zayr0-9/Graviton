import type {
  HeadlessStreamEvent,
  HeadlessSubagentStreamEvent,
  HeadlessSubagentStreamRequest,
} from '../contracts/headlessApi.js'
import {
  SubagentRunRepo,
  type SubagentMessageRow,
  type SubagentRunRow,
  type SubagentRunStatus,
} from '../persistence/subagentRunRepo.js'
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

/** Persisted run context produced before the loop drives; carries the ids the manager needs. */
interface PreparedSubagentRun {
  runId: string
  handle: string | null
  subStreamId: string
  userMessage: SubagentMessageRow
  provider: string
  modelName: string
  operationMode: 'plan' | 'execute'
  maxTurns: number
  tools: ProviderToolDefinition[]
  resolvedToolNames: string[]
}

/** A detached (async) run tracked in-process so the manager can cancel it by handle. */
interface ActiveSubagentRun {
  runId: string
  controller: AbortController
}

const NOOP_EMIT = (_event: HeadlessSubagentStreamEvent): void => {}

export class SubagentRunService {
  private readonly runRepo: SubagentRunRepo
  private readonly streamingRunRepo: StreamingRunRepo
  private readonly providerRouter: ProviderRouter
  private readonly toolExecutor: ToolExecutor
  private readonly resolveToolsByName: (names: string[] | undefined) => ResolvedSubagentTools
  private readonly compactionService: CompactionSummaryGenerator
  private readonly refreshProviderTokens?: (provider: string) => Promise<void> | void
  private readonly providerTurnTimeoutMs: number
  /** handle -> live detached run, so cancel(handle) can abort a run that outlives its spawn call. */
  private readonly activeRuns = new Map<string, ActiveSubagentRun>()

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
    const prepared = await this.prepareRun(request, emit)
    await this.driveRun(prepared, request, emit, signal)
  }

  /**
   * Fire-and-forget spawn for the subagent manager. Persists the run far enough to
   * return its handle immediately, then drives the loop in the BACKGROUND under an
   * owned AbortController (registered by handle so cancel(handle) works). The run
   * outlives the spawning tool call. driveRun persists all terminal state; the
   * .catch is a backstop for an unexpected throw outside driveRun's own try.
   */
  async spawnDetached(
    request: HeadlessSubagentStreamRequest
  ): Promise<{ handle: string | null; runId: string; streamId: string }> {
    const controller = new AbortController()
    const prepared = await this.prepareRun(request, NOOP_EMIT)
    if (prepared.handle) {
      this.activeRuns.set(prepared.handle, { runId: prepared.runId, controller })
    }
    void this.driveRun(prepared, request, NOOP_EMIT, controller.signal)
      .catch(error => this.persistUnexpectedFailure(prepared, error))
      .finally(() => {
        if (prepared.handle) this.activeRuns.delete(prepared.handle)
      })
    return { handle: prepared.handle, runId: prepared.runId, streamId: prepared.subStreamId }
  }

  /**
   * Cancel a detached run by handle. Returns true if a live run was found and
   * signalled to abort (driveRun then marks it 'aborted'); false if no live run
   * maps to the handle (already terminal, unknown, or blocking).
   */
  cancel(handle: string): boolean {
    const active = this.activeRuns.get(handle)
    if (!active) return false
    active.controller.abort()
    return true
  }

  /** True if the handle maps to a run currently executing in THIS process. */
  isActive(handle: string): boolean {
    return this.activeRuns.has(handle)
  }

  /**
   * Blocking spawn for the subagent manager. Uses the SAME prepareRun/driveRun
   * engine and persistence as spawnDetached — the only difference is that it
   * awaits the loop and returns the terminal outcome inline (handle + result +
   * status). Unlike runForTool it does NOT throw on a subagent-level error: the
   * manager surfaces error/aborted structurally so the model can choose to
   * resume or spawn anew. driveRun still persists every terminal state.
   */
  async spawnBlocking(
    request: HeadlessSubagentStreamRequest,
    signal: AbortSignal
  ): Promise<{
    handle: string | null
    runId: string
    streamId: string
    status: SubagentRunStatus
    result: string
    error: string | null
  }> {
    let result = ''
    let terminalError: string | null = null
    let aborted = false
    const emit = (event: HeadlessSubagentStreamEvent): void => {
      if (event.type === 'complete' && 'result' in event) {
        result = event.result
      } else if (event.type === 'error') {
        terminalError = event.error
        if ((event as { aborted?: boolean }).aborted) aborted = true
      }
    }
    const prepared = await this.prepareRun(request, emit)
    await this.driveRun(prepared, request, emit, signal)
    const status: SubagentRunStatus = aborted || signal.aborted ? 'aborted' : terminalError ? 'error' : 'completed'
    return {
      handle: prepared.handle,
      runId: prepared.runId,
      streamId: prepared.subStreamId,
      status,
      result,
      error: terminalError,
    }
  }

  /** Resolve a run by its 6-digit handle (manager status/cancel/resume ownership checks). */
  getRunByHandle(handle: string): SubagentRunRow | null {
    return this.runRepo.getRunByHandle(handle)
  }

  /** Runs owned by a content lineage (+ optional status) — backs the manager's branch-scoped list. */
  listByLineage(lineageId: string, status?: SubagentRunStatus): SubagentRunRow[] {
    return this.runRepo.listByLineage(lineageId, status)
  }

  private async prepareRun(
    request: HeadlessSubagentStreamRequest,
    emit: (event: HeadlessSubagentStreamEvent) => void
  ): Promise<PreparedSubagentRun> {
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
      lineageId: request.lineageId ?? null,
      parentMessageId: request.parentMessageId,
      toolCallId: request.toolCallId ?? null,
      prompt: request.prompt,
      provider,
      modelName,
      systemPrompt: request.systemPrompt ?? null,
      status: 'running',
    })
    const runId = run.id

    // Child streaming_runs row uses a fresh run id while retaining content ownership.
    const subStreamId = this.streamingRunRepo.upsert({
      lineageId: request.lineageId ?? null,
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
      lineageId: request.lineageId ?? null,
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

    return {
      runId,
      handle: run.handle,
      subStreamId,
      userMessage,
      provider,
      modelName,
      operationMode,
      maxTurns,
      tools,
      resolvedToolNames,
    }
  }

  private async driveRun(
    prepared: PreparedSubagentRun,
    request: HeadlessSubagentStreamRequest,
    emit: (event: HeadlessSubagentStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const { runId, subStreamId, userMessage, provider, modelName, operationMode, maxTurns, tools } = prepared

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
          robustness: { retryEmptyTurn: true, finalizeOnSilentToolEnd: true, retryProviderError: true },
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
        lineageId: request.lineageId ?? null,
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
        emit({
          type: 'error',
          subagentRunId: runId,
          lineageId: request.lineageId ?? null,
          error: 'Subagent aborted',
          aborted: true,
        })
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
          lineageId: request.lineageId ?? null,
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
      emit({
        type: 'error',
        subagentRunId: runId,
        lineageId: request.lineageId ?? null,
        error: message,
        provider,
      })
    }
  }

  /**
   * Backstop for a detached run that throws OUTSIDE driveRun's own try/catch
   * (driveRun already persists completed/error/aborted for the normal paths).
   */
  private persistUnexpectedFailure(prepared: PreparedSubagentRun, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      this.runRepo.updateRun(prepared.runId, { status: 'error', error: message })
      this.streamingRunRepo.finish(prepared.subStreamId, {
        status: 'error',
        endReason: 'error',
        error: message,
        metadata: { subagent_run_id: prepared.runId },
      })
    } catch (persistError) {
      console.warn('[subagent] failed to persist unexpected detached failure:', persistError)
    }
  }
}
