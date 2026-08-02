import type { HeadlessStreamEvent } from '../contracts/headlessApi.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import { ToolInvocationRepo } from '../persistence/toolInvocationRepo.js'
import { TreeMessageSink, type MessageSink } from './messageSink.js'
import type {
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderToolCall,
  ProviderToolDefinition,
} from '../providers/openRouterProvider.js'
import { ProviderRouter, normalizeProviderRoute } from './providerRouter.js'
import { persistWithFallback, type ToolResultPersistencePolicy } from './toolResultPersistenceService.js'
import { sanitizeToolResultContentForModel } from '../providers/toolResultSanitizer.js'
import { formatProviderErrorForAssistant, type FormattedProviderError } from '../providers/providerErrorFormatter.js'
import { trimHistoryToLatestCompaction } from './compactionService.js'
import { assertToolAllowedForOperationMode, requiresAgentMode } from '../../../../../shared/operationModeToolPolicy.js'
import {
  extractOpenAIContextUsageFromBlocks,
  openAIModelContextLength,
  resolveOpenAIContinuationCompaction,
  type OpenAIContextUsage,
} from '../../../../../shared/contextUsage.js'

export interface ToolExecutionContext {
  conversationId: string
  messageId: string
  streamId?: string | null
  rootPath?: string | null
  operationMode?: 'plan' | 'execute'
  provider?: string
  modelName?: string
  autoApprove?: boolean
  subagentReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  timeoutMs?: number
  signal?: AbortSignal
  /** Policy-aware executor used by composite tools for each nested call. */
  nestedExecutor?: ToolExecutor
  /** Durable execution identity of the currently executing parent tool. */
  parentToolInvocationId?: string | null
  lineageId?: string | null
}

export type ToolExecutor = (toolCall: ProviderToolCall, context: ToolExecutionContext) => Promise<any>

export type ToolLoopCompactor = (input: {
  conversationId: string
  parentMessageId: string
  messages: any[]
  provider: string
  modelName: string
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  systemPrompt?: string | null
}) => Promise<{ message: any }>

interface ToolLoopServiceDeps {
  /**
   * Message persistence port. Provide `sink` directly, or `messageRepo` to get
   * the default tree persistence (wrapped in TreeMessageSink). One is required.
   */
  messageRepo?: MessageRepo
  sink?: MessageSink
  providerRouter: ProviderRouter
  executeTool?: ToolExecutor
  toolInvocationRepo?: ToolInvocationRepo
  maxTurns?: number
  persistencePolicy?: Partial<ToolResultPersistencePolicy>
  providerTurnTimeoutMs?: number
  compactBranch?: ToolLoopCompactor
}

export interface ToolLoopRobustnessOptions {
  /** Retry a provider turn once when it comes back empty (no text/tools/image). */
  retryEmptyTurn?: boolean
  /** When tools ran but the loop ends with no visible answer, run one tool-free finalization turn. */
  finalizeOnSilentToolEnd?: boolean
  /** Override the finalization user instruction. */
  finalizationInstruction?: string
  /** Base delay (ms) before an empty-turn retry; jitter is added on top. */
  emptyTurnRetryDelayMs?: number
}

/**
 * Phase 3 chat-hook adapter. Supplied only by the ChatOrchestrator (via a
 * ChatHookSession) when hooks are enabled for the run; absent for subagents/tests,
 * which then behave exactly as before. Implemented in chatHookService.ts.
 */
export interface ToolLoopHooks {
  /** Shared accumulator the executor (Pre/Post/Failure) and the loop (Stop) both push to. */
  hookContext: string[]
  /**
   * Fold the currently-accumulated hook context onto the run's base system prompt.
   * MUST return the base unchanged (possibly null) when nothing is accumulated.
   */
  foldSystemPrompt(baseSystemPrompt: string | null): string | null
  /** Stop hook: returns true to force one more turn on a would-be natural stop. */
  runStop(params: { assistantMessage: any; streamId: string | null }): Promise<boolean>
}

export interface ToolLoopRunInput {
  provider: string
  operation?: 'send' | 'repeat' | 'branch' | 'edit-branch'
  modelName: string
  conversationId: string
  /** Stable content lineage. Optional so subagent and legacy callers remain unaffected. */
  lineageId?: string | null
  assistantParentId: string | null
  history: any[]
  userContent: string
  systemPrompt?: string | null
  conversationContext?: string | null
  projectContext?: string | null
  think?: boolean
  temperature?: number
  userId?: string | null
  accessToken?: string | null
  accountId?: string | null
  attachmentsBase64?: any[] | null
  retrigger?: boolean
  executionMode?: 'server' | 'client'
  isBranch?: boolean
  isElectron?: boolean
  imageConfig?: any
  reasoningConfig?: any
  serviceTier?: 'priority'
  promptCacheRetention?: 'in_memory' | '24h'
  tools?: ProviderToolDefinition[]
  streamId?: string | null
  rootPath?: string | null
  operationMode?: 'plan' | 'execute'
  /** Agent-mode prompt selected by the orchestrator if this run is upgraded mid-turn. */
  agentSystemPrompt?: string | null
  /** Server-owned prompt to switch the current Plan-mode run to Agent mode. */
  requestOperationModeUpgrade?: (toolCall: ProviderToolCall) => Promise<boolean>
  toolTimeoutMs?: number
  /** Parent tool-approval policy, forwarded to server-owned subagent calls. */
  toolAutoApprove?: boolean
  /** Reasoning effort to apply to child subagent calls. */
  subagentReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
  autoCompactionEnabled?: boolean
  contextLength?: number
  compactionThresholdPercent?: number
  compactionProvider?: string | null
  compactionModelName?: string | null
  compactionSystemPrompt?: string | null
  /** Per-run turn cap; clamped to [1, service maxTurns]. Defaults to service maxTurns. */
  maxTurns?: number
  /** Abort signal; checked between turns and before each tool, and forwarded to the provider. */
  signal?: AbortSignal
  /** Overrides the codex session / prompt-cache key (railwayTurn.conversationId). */
  railwaySessionId?: string | null
  /** Forwarded to openaichatgpt so commentary text can back-fill an empty final answer. */
  allowCommentaryFallbackText?: boolean
  /**
   * Phase 4: relay Railway free-tier SSE frames (free_generations_update /
   * generation_limit_reached) up through the OpenRouter provider. Set only by the
   * server-owned cloud chat path. Absent (subagents/tests/native providers) => the
   * provider drops the frames exactly as before.
   */
  relayFreeTierEvents?: boolean
  /** Opt-in robustness behaviors; all default off so main-chat behavior is unchanged. */
  robustness?: ToolLoopRobustnessOptions
  /**
   * Opt-in chat hooks (Phase 3). When present, the loop folds accumulated hook
   * context into each turn's system prompt and runs the Stop hook at a natural stop.
   * Absent (subagents/tests) => no fold, no Stop hook — behavior is unchanged.
   */
  hooks?: ToolLoopHooks
}

export interface ToolLoopRunResult {
  finalAssistantMessage: any
  turnsUsed: number
  anyToolsExecuted: boolean
  providerError?: FormattedProviderError
}

export class ProviderErrorAssistantResponse extends Error {
  readonly assistantMessage: any
  readonly providerError: FormattedProviderError
  readonly turnsUsed: number

  constructor(input: { assistantMessage: any; providerError: FormattedProviderError; turnsUsed: number }) {
    super(input.providerError.originalMessage)
    this.name = 'ProviderErrorAssistantResponse'
    this.assistantMessage = input.assistantMessage
    this.providerError = input.providerError
    this.turnsUsed = input.turnsUsed
  }
}

export class ProviderEmptyResponseError extends Error {
  readonly provider: string
  readonly modelName: string
  readonly turnsUsed: number

  constructor(input: { provider: string; modelName: string; turnsUsed: number }) {
    super('Provider returned an empty response after retry')
    this.name = 'ProviderEmptyResponseError'
    this.provider = input.provider
    this.modelName = input.modelName
    this.turnsUsed = input.turnsUsed
  }
}

const DEFAULT_MAX_TURNS = 400
const DEFAULT_PROVIDER_TURN_TIMEOUT_MS = 180_000
const EMPTY_TURN_RETRY_BASE_MS = 600
const EMPTY_TURN_RETRY_JITTER_MS = 400
const DEFAULT_FINALIZATION_INSTRUCTION =
  'Summarize the tool results above and provide the final answer. Do not call tools. Be concise and complete.'
const THINKING_WRAPPER_PATTERN = /<thinking>[\s\S]*?<\/thinking>\s*/gi

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as any).name === 'AbortError'
}

function makeAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }
  const error = new Error('The operation was aborted.')
  ;(error as any).name = 'AbortError'
  return error
}

function stripThinkingWrapper(text: string): string {
  if (!text) return ''
  return text.replace(THINKING_WRAPPER_PATTERN, '').trim()
}

function outputHasImageBlock(output: ProviderGenerateOutput): boolean {
  return Array.isArray(output.contentBlocks) && output.contentBlocks.some(block => block?.type === 'image')
}

/** A turn is "empty" when it yields no tool calls, no image, and no text after stripping reasoning. */
function isEmptyTurnOutput(output: ProviderGenerateOutput): boolean {
  if (Array.isArray(output.toolCalls) && output.toolCalls.length > 0) return false
  if (outputHasImageBlock(output)) return false
  return stripThinkingWrapper(output.content || '').length === 0
}

function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(makeAbortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function withTimeoutAndAbort<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  const boundedTimeoutMs = Math.max(1_000, timeoutMs)

  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError())
      return
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${label} timed out after ${boundedTimeoutMs}ms`))
    }, boundedTimeoutMs)
    const onAbort = () => {
      cleanup()
      reject(makeAbortError())
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    task.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

function parseJsonArray(value: any): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function approximateTokens(value: unknown): number {
  if (value == null) return 0
  let serialized: string
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    serialized = String(value)
  }
  return Math.ceil(serialized.length / 4)
}

/**
 * Estimate the model-visible token cost of one history message for the compaction
 * projection. Deliberately NOT `approximateTokens(wholeRow)`: a persisted row duplicates
 * its text across `content`, `plain_text_content`, AND `content_blocks`, carries row
 * metadata (ids, children_ids, timestamps, note), and re-escapes the already-stringified
 * `content_blocks` — inflating the estimate several-fold. That inflation, fed through
 * resolveOpenAIContinuationCompaction's Math.max(reported, projected), let compaction fire
 * while the real reported usage was still low (the ~50k early-fire). Count ONE canonical
 * text representation per message, and skip `role:'tool'` entries whose result is already
 * merged into the preceding assistant message's content_blocks (avoids double-counting).
 */
export function estimateHistoryMessageTokens(message: unknown): number {
  if (message == null) return 0
  if (typeof message !== 'object') return approximateTokens(message)
  const msg = message as { role?: unknown; content?: unknown; content_blocks?: unknown }
  // Tool-result entries are also merged into the assistant row's content_blocks — count once.
  if (msg.role === 'tool') return 0
  // content_blocks (when present) is the richest single representation (text + tool_use +
  // tool_result); fall back to `content`. Take the larger so an empty blocks array does not
  // under-count. Estimate content_blocks as its raw string (no whole-row re-escaping).
  const blocks = msg.content_blocks
  const fromBlocks = blocks == null ? 0 : approximateTokens(typeof blocks === 'string' ? blocks : JSON.stringify(blocks))
  const fromContent = approximateTokens(msg.content)
  return Math.max(fromBlocks, fromContent)
}

function projectedReplayTokens(input: ToolLoopRunInput, history: any[]): number {
  return (
    approximateTokens(input.systemPrompt) +
    approximateTokens(input.conversationContext) +
    approximateTokens(input.projectContext) +
    history.reduce((total, message) => total + estimateHistoryMessageTokens(message), 0)
  )
}

function usageFromMessage(message: any): OpenAIContextUsage | null {
  const direct = message?.context_usage
  if (direct && typeof direct === 'object' && direct.provider === 'openai') return direct as OpenAIContextUsage
  return extractOpenAIContextUsageFromBlocks(message?.content_blocks)
}

function getToolResultPersistedContent(result: any): any {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  if (Object.prototype.hasOwnProperty.call(result, 'persistedContent')) return result.persistedContent
  if (Object.prototype.hasOwnProperty.call(result, 'displayContent')) return result.displayContent
  return result
}

function getToolResultModelContent(result: any): any {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return getToolResultPersistedContent(result)
  if (Object.prototype.hasOwnProperty.call(result, 'modelContent')) return result.modelContent
  return getToolResultPersistedContent(result)
}

export function toToolResultContent(result: any): string {
  const persistedContent = getToolResultPersistedContent(result)
  if (typeof persistedContent === 'string') return persistedContent
  try {
    // Coalesce undefined -> null so this always returns a string (JSON.stringify(undefined)
    // is the JS value `undefined`, not "null"). Mirrors the renderer's
    // serializeToolResultContent(getToolResultPersistedContent(result)) which does
    // JSON.stringify(content ?? null) — keeps the persisted tool_result block AND the
    // PostToolUse hook payload's tool_result identical across renderer/server.
    return JSON.stringify(persistedContent ?? null)
  } catch {
    return String(persistedContent ?? null)
  }
}

function toModelToolResultContent(content: string, toolName?: string | null): string {
  const sanitized = sanitizeToolResultContentForModel(content, toolName ?? null)
  if (typeof sanitized === 'string') return sanitized
  try {
    return JSON.stringify(sanitized ?? null)
  } catch {
    return String(sanitized)
  }
}

function normalizeToolCall(raw: any): ProviderToolCall | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : null
  if (!id || !name) return null

  return {
    id,
    name,
    arguments: raw.arguments ?? {},
    status: raw.status ?? 'pending',
  }
}

function appendGeneratedBlocks(output: ProviderGenerateOutput): any[] {
  const blocks = Array.isArray(output.contentBlocks) ? [...output.contentBlocks] : []

  const hasTextBlock = blocks.some(block => block?.type === 'text')
  if (output.content && !hasTextBlock) {
    blocks.push({ type: 'text', content: output.content })
  }

  if (output.reasoning && !blocks.some(block => block?.type === 'thinking')) {
    blocks.unshift({ type: 'thinking', content: output.reasoning })
  }

  if (Array.isArray(output.toolCalls)) {
    for (const call of output.toolCalls) {
      if (!call?.id || !call?.name) continue
      const alreadyPresent = blocks.some(block => block?.type === 'tool_use' && block?.id === call.id)
      if (!alreadyPresent) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        })
      }
    }
  }

  return blocks
}

/**
 * Phase 4: pending -> execute -> tool_result -> continue loop.
 */
export class ToolLoopService {
  private readonly sink: MessageSink
  private readonly providerRouter: ProviderRouter
  private readonly executeTool?: ToolExecutor
  private readonly toolInvocationRepo?: ToolInvocationRepo
  private readonly maxTurns: number
  private readonly persistencePolicy?: Partial<ToolResultPersistencePolicy>
  private readonly providerTurnTimeoutMs: number
  private readonly compactBranch?: ToolLoopCompactor

  constructor(deps: ToolLoopServiceDeps) {
    if (deps.sink) {
      this.sink = deps.sink
    } else if (deps.messageRepo) {
      this.sink = new TreeMessageSink({ messageRepo: deps.messageRepo })
    } else {
      throw new Error('ToolLoopService requires either a sink or a messageRepo')
    }
    this.providerRouter = deps.providerRouter
    this.executeTool = deps.executeTool
    this.toolInvocationRepo = deps.toolInvocationRepo
    this.maxTurns = Math.max(1, deps.maxTurns ?? DEFAULT_MAX_TURNS)
    this.persistencePolicy = deps.persistencePolicy
    this.providerTurnTimeoutMs = Math.max(5_000, deps.providerTurnTimeoutMs ?? DEFAULT_PROVIDER_TURN_TIMEOUT_MS)
    this.compactBranch = deps.compactBranch
  }

  /**
   * Issue one provider turn: build the request, generate (with per-turn timeout
   * and abort), emit stream events, and surface a provider error as a persisted
   * assistant message + ProviderErrorAssistantResponse. Abort errors propagate
   * unwrapped so callers can distinguish cancellation from provider failure.
   */
  private async generateProviderTurn(params: {
    input: ToolLoopRunInput
    history: any[]
    userContent: string
    parentId: string | null
    turn: number
    maxTurns: number
    disableTools: boolean
    emit: (event: HeadlessStreamEvent) => void
    /**
     * Per-turn system prompt (Phase 3 hook fold). When provided (even null), it
     * replaces input.systemPrompt for this turn. Absent => input.systemPrompt as before.
     */
    systemPromptOverride?: string | null
  }): Promise<ProviderGenerateOutput> {
    const { input, emit, turn, maxTurns } = params
    const providerRoute = normalizeProviderRoute(input.provider)
    const providerInput: ProviderGenerateInput = {
      modelName: input.modelName,
      systemPrompt: params.systemPromptOverride !== undefined ? params.systemPromptOverride : (input.systemPrompt ?? null),
      history: params.history,
      userContent: params.userContent,
      userId: input.userId ?? null,
      accessToken: input.accessToken ?? null,
      accountId: input.accountId ?? null,
      tools: params.disableTools ? undefined : input.tools,
      think: input.think,
      temperature: input.temperature,
      signal: input.signal,
      railwayTurn:
        providerRoute === 'openrouter' || providerRoute === 'openaichatgpt'
          ? {
              conversationId: input.railwaySessionId || input.conversationId,
              parentId: params.parentId,
              operation: input.operation,
              conversationContext: input.conversationContext ?? null,
              projectContext: input.projectContext ?? null,
              think: input.think,
              temperature: input.temperature,
              attachmentsBase64: turn === 1 && !params.disableTools ? (input.attachmentsBase64 ?? null) : null,
              retrigger: turn === 1 && !params.disableTools ? input.retrigger : false,
              executionMode: input.executionMode,
              isBranch: input.isBranch,
              storageMode: 'local',
              relayFreeTierEvents: input.relayFreeTierEvents ?? false,
              isElectron: input.isElectron ?? true,
              imageConfig: input.imageConfig,
              reasoningConfig: input.reasoningConfig,
              serviceTier: input.serviceTier,
              promptCacheRetention: input.promptCacheRetention,
              ...(input.allowCommentaryFallbackText != null
                ? { allowCommentaryFallbackText: input.allowCommentaryFallbackText }
                : {}),
            }
          : null,
    }

    let streamedTextDuringTurn = false
    let streamedReasoningDuringTurn = false
    let output: ProviderGenerateOutput
    try {
      output = await withTimeoutAndAbort(
        this.providerRouter.generate(input.provider, providerInput, event => {
          if (event?.type === 'chunk' && event.part === 'text' && typeof event.delta === 'string' && event.delta.length > 0) {
            streamedTextDuringTurn = true
          }
          if (
            event?.type === 'chunk' &&
            event.part === 'reasoning' &&
            typeof event.delta === 'string' &&
            event.delta.length > 0
          ) {
            streamedReasoningDuringTurn = true
          }
          emit(event)
        }),
        this.providerTurnTimeoutMs,
        `Provider turn ${turn}/${maxTurns}`,
        input.signal
      )
    } catch (error) {
      // Cancellation is not a provider failure; propagate it so the run aborts cleanly.
      if (input.signal?.aborted || isAbortError(error)) {
        throw error
      }

      const providerError = formatProviderErrorForAssistant(error, {
        provider: input.provider,
        modelName: input.modelName,
      })

      if (providerError) {
        const assistantMessage = this.sink.persistAssistantMessage({
          conversationId: input.conversationId,
          parentId: params.parentId,
          content: providerError.message,
          modelName: input.modelName,
          contentBlocks: [{ type: 'text', content: providerError.message }],
        })

        if (!streamedTextDuringTurn) {
          emit({ type: 'chunk', part: 'text', delta: providerError.message })
        }
        emit({ type: 'assistant_message_persisted', message: assistantMessage })
        throw new ProviderErrorAssistantResponse({ assistantMessage, providerError, turnsUsed: turn })
      }

      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', error: `Continuation generation failed on turn ${turn}/${maxTurns}: ${message}` })
      throw error
    }

    if (output.contextUsage) {
      emit({ type: 'context_usage', usage: output.contextUsage })
    }
    if (output.reasoning && !streamedReasoningDuringTurn) {
      emit({ type: 'chunk', part: 'reasoning', delta: output.reasoning })
    }
    if (output.content && !streamedTextDuringTurn) {
      emit({ type: 'chunk', part: 'text', delta: output.content })
    }

    return output
  }

  /**
   * One extra tool-free turn that asks the model to summarize prior tool results.
   * Fixes the failure mode where a run ends with tool activity but no visible
   * answer. Empty output here is a hard failure (ProviderEmptyResponseError).
   */
  private async runFinalizationTurn(params: {
    input: ToolLoopRunInput
    history: any[]
    parentId: string | null
    turnsSoFar: number
    maxTurns: number
    anyToolsExecuted: boolean
    emit: (event: HeadlessStreamEvent) => void
  }): Promise<ToolLoopRunResult> {
    const { input, emit } = params
    const finalizeTurn = params.turnsSoFar + 1
    const instruction = input.robustness?.finalizationInstruction || DEFAULT_FINALIZATION_INSTRUCTION

    emit({ type: 'tool_loop', status: 'finalization_turn', turn: finalizeTurn, maxTurns: params.maxTurns })

    const history = [...params.history, { role: 'user', content: instruction }]
    const output = await this.generateProviderTurn({
      input,
      history,
      userContent: instruction,
      parentId: params.parentId,
      turn: finalizeTurn,
      maxTurns: params.maxTurns,
      disableTools: true,
      emit,
    })

    const contentBlocks = appendGeneratedBlocks({ ...output, toolCalls: [] })
    const assistantMessage = this.sink.persistAssistantMessage({
      conversationId: input.conversationId,
      parentId: params.parentId,
      content: output.content || '',
      modelName: input.modelName,
      contentBlocks,
      contextUsage: output.contextUsage,
      thinkingBlock: output.reasoning ?? null,
      // Phase 4: adopt Railway's id on the cloud path (see the main-turn persist site).
      providerMessageId: output.raw && typeof output.raw.id === 'string' ? output.raw.id : null,
    })
    emit({ type: 'assistant_message_persisted', message: assistantMessage })

    if (!stripThinkingWrapper(output.content || '')) {
      throw new ProviderEmptyResponseError({
        provider: input.provider,
        modelName: input.modelName,
        turnsUsed: finalizeTurn,
      })
    }

    emit({ type: 'tool_loop', status: 'turn_completed', turn: finalizeTurn, maxTurns: params.maxTurns, continued: false })
    return {
      finalAssistantMessage: assistantMessage,
      turnsUsed: finalizeTurn,
      anyToolsExecuted: params.anyToolsExecuted,
    }
  }

  async run(input: ToolLoopRunInput, emit: (event: HeadlessStreamEvent) => void): Promise<ToolLoopRunResult> {
    const maxTurns = Math.max(1, Math.min(input.maxTurns ?? this.maxTurns, this.maxTurns))
    const robustness = input.robustness
    let currentParentId = input.assistantParentId
    let currentUserContent = input.userContent
    // Defend the provider boundary for direct callers as well as ChatOrchestrator.
    // Persistence retains the full branch; model replay begins at its latest summary.
    let history = trimHistoryToLatestCompaction(input.history || [])
    let lastAssistantMessage: any = null
    let anyToolsExecuted = false
    let activeOperationMode = input.operationMode ?? 'execute'
    // Phase 3: true iff the most recent iteration was a natural stop (no tool calls)
    // that a Stop hook forced to continue. Used only at the max-turns boundary to
    // finalize gracefully with the valid persisted answer (parity with the renderer,
    // which exits its while loop at MAX_TURNS and completes) instead of hard-erroring.
    let stopHookForcedContinue = false

    for (let turn = 1; turn <= maxTurns; turn++) {
      input.signal?.throwIfAborted()
      stopHookForcedContinue = false

      // Phase 3: fold accumulated hook context into this turn's system prompt, then
      // clear the buffer (parity with the renderer's per-iteration fold+clear,
      // chatActions.ts:3217-3225). `undefined` => no hooks => provider gets
      // input.systemPrompt unchanged.
      let turnSystemPromptOverride: string | null | undefined
      if (input.hooks) {
        turnSystemPromptOverride = input.hooks.foldSystemPrompt(input.systemPrompt ?? null)
        input.hooks.hookContext.length = 0
      }

      emit({
        type: 'tool_loop',
        status: 'turn_started',
        turn,
        maxTurns,
      })

      // Generate the turn, retrying once on an empty response when enabled.
      let output = await this.generateProviderTurn({
        input,
        history,
        userContent: currentUserContent,
        parentId: currentParentId,
        turn,
        maxTurns,
        disableTools: false,
        emit,
        systemPromptOverride: turnSystemPromptOverride,
      })

      if (robustness?.retryEmptyTurn && isEmptyTurnOutput(output)) {
        emit({ type: 'tool_loop', status: 'empty_turn_retry', turn, maxTurns })
        const baseDelay = robustness.emptyTurnRetryDelayMs ?? EMPTY_TURN_RETRY_BASE_MS
        await abortAwareSleep(baseDelay + Math.floor(Math.random() * EMPTY_TURN_RETRY_JITTER_MS), input.signal)
        output = await this.generateProviderTurn({
          input,
          history,
          userContent: currentUserContent,
          parentId: currentParentId,
          turn,
          maxTurns,
          disableTools: false,
          emit,
          systemPromptOverride: turnSystemPromptOverride,
        })
      }

      const assistantToolCalls = Array.isArray(output.toolCalls)
        ? output.toolCalls.map(normalizeToolCall).filter((call): call is ProviderToolCall => Boolean(call))
        : []

      const assistantContentBlocks = appendGeneratedBlocks({
        ...output,
        toolCalls: assistantToolCalls,
      })

      const assistantMessage = this.sink.persistAssistantMessage({
        conversationId: input.conversationId,
        parentId: currentParentId,
        content: output.content || '',
        modelName: input.modelName,
        toolCalls: assistantToolCalls,
        contentBlocks: assistantContentBlocks,
        contextUsage: output.contextUsage,
        thinkingBlock: output.reasoning ?? null,
        // Phase 4: Railway's authoritative message id (when the provider surfaced a
        // complete frame). Only CloudMirrorSink adopts it; TreeMessageSink ignores it,
        // and it is null for native providers / streamed-only frames => mint parity.
        providerMessageId: output.raw && typeof output.raw.id === 'string' ? output.raw.id : null,
      })

      lastAssistantMessage = assistantMessage
      history.push(assistantMessage)
      const assistantHistoryIndex = history.length - 1
      emit({ type: 'assistant_message_persisted', message: assistantMessage })

      if (!assistantToolCalls.length) {
        // Phase 3 Stop hook (parity with the renderer's shouldContinueFromStopHook,
        // chatActions.ts:3567-3587): on a would-be natural stop, a configured Stop hook
        // may force one more turn. Reuses the existing for-loop — no parallel loop. The
        // just-persisted assistantMessage is already in history; continuing injects an
        // empty user turn parented on it, exactly like the renderer. No-op without hooks.
        if (input.hooks) {
          const forceContinue = await input.hooks.runStop({
            assistantMessage,
            streamId: input.streamId ?? null,
          })
          if (forceContinue) {
            emit({ type: 'tool_loop', status: 'turn_completed', turn, maxTurns, continued: true })
            currentParentId = assistantMessage.id
            currentUserContent = ''
            stopHookForcedContinue = true
            continue
          }
        }

        const strippedText = stripThinkingWrapper(output.content || '')

        // Tools ran but the model gave no visible answer: recover with a summary turn.
        if (!strippedText && robustness?.finalizeOnSilentToolEnd && anyToolsExecuted) {
          return await this.runFinalizationTurn({
            input,
            history,
            parentId: assistantMessage.id,
            turnsSoFar: turn,
            maxTurns,
            anyToolsExecuted,
            emit,
          })
        }

        // Provider produced nothing and no tools ever ran: a real failure, not fake success.
        if (!strippedText && robustness?.retryEmptyTurn && !anyToolsExecuted) {
          emit({ type: 'tool_loop', status: 'turn_completed', turn, maxTurns, continued: false })
          throw new ProviderEmptyResponseError({
            provider: input.provider,
            modelName: input.modelName,
            turnsUsed: turn,
          })
        }

        emit({
          type: 'tool_loop',
          status: 'turn_completed',
          turn,
          maxTurns,
          continued: false,
        })

        return {
          finalAssistantMessage: assistantMessage,
          turnsUsed: turn,
          anyToolsExecuted,
        }
      }

      if (!this.executeTool) {
        emit({
          type: 'tool_loop',
          status: 'turn_completed',
          turn,
          maxTurns,
          continued: false,
        })

        return {
          finalAssistantMessage: assistantMessage,
          turnsUsed: turn,
          anyToolsExecuted,
        }
      }

      anyToolsExecuted = true
      const toolResultBlocks: any[] = []

      for (const toolCall of assistantToolCalls) {
        input.signal?.throwIfAborted()
        emit({ type: 'chunk', part: 'tool_call', toolCall })

        // Invocation lifecycle persistence is strict at create time: executing without
        // an ownership record would violate durability. It is enabled only when a
        // stable content lineage is available, preserving subagent/legacy behavior.
        const invocation = input.lineageId && this.toolInvocationRepo
          ? this.toolInvocationRepo.create({
              conversationId: input.conversationId,
              lineageId: input.lineageId,
              runId: input.streamId ?? null,
              toolCallId: toolCall.id,
              assistantMessageId: assistantMessage.id,
              toolName: toolCall.name,
            })
          : null
        emit({
          type: 'tool_execution',
          status: 'started',
          toolCallId: toolCall.id,
          toolInvocationId: invocation?.id,
          lineageId: input.lineageId ?? null,
          toolName: toolCall.name,
        })

        let toolResultContent = ''
        let modelToolResultContent: any = ''
        let toolError = false
        const startedAt = Date.now()

        try {
          if (requiresAgentMode(toolCall, activeOperationMode)) {
            const upgraded = await input.requestOperationModeUpgrade?.(toolCall)
            if (!upgraded) {
              assertToolAllowedForOperationMode(toolCall, activeOperationMode)
            }
            activeOperationMode = 'execute'
            input.systemPrompt = input.agentSystemPrompt ?? input.systemPrompt
          }
          assertToolAllowedForOperationMode(toolCall, activeOperationMode)

          const executeNested: ToolExecutor = async (nestedCall, nestedContext) => {
            const nestedInvocation = input.lineageId && this.toolInvocationRepo
              ? this.toolInvocationRepo.create({
                  conversationId: input.conversationId,
                  lineageId: input.lineageId,
                  runId: input.streamId ?? null,
                  parentToolInvocationId: nestedContext.parentToolInvocationId ?? invocation?.id ?? null,
                  toolCallId: nestedCall.id,
                  assistantMessageId: assistantMessage.id,
                  toolName: nestedCall.name,
                })
              : null
            const nestedStartedAt = Date.now()
            emit({ type: 'tool_execution', status: 'started', toolCallId: nestedCall.id, toolInvocationId: nestedInvocation?.id, lineageId: input.lineageId ?? null, toolName: nestedCall.name })
            try {
              const nestedResult = await this.executeTool!(nestedCall, {
                ...nestedContext,
                parentToolInvocationId: nestedInvocation?.id ?? nestedContext.parentToolInvocationId ?? null,
                lineageId: input.lineageId ?? null,
                nestedExecutor: executeNested,
              })
              nestedInvocation && this.toolInvocationRepo?.finish(nestedInvocation.id, { status: 'completed' })
              emit({ type: 'tool_execution', status: 'completed', toolCallId: nestedCall.id, toolInvocationId: nestedInvocation?.id, lineageId: input.lineageId ?? null, toolName: nestedCall.name, durationMs: Math.max(0, Date.now() - nestedStartedAt) })
              return nestedResult
            } catch (error) {
              const aborted = nestedContext.signal?.aborted || isAbortError(error)
              const errorText = aborted ? 'Tool execution aborted' : error instanceof Error ? error.message : String(error)
              nestedInvocation && this.toolInvocationRepo?.finish(nestedInvocation.id, { status: aborted ? 'aborted' : 'failed', error: errorText })
              emit({ type: 'tool_execution', status: aborted ? 'aborted' : 'failed', toolCallId: nestedCall.id, toolInvocationId: nestedInvocation?.id, lineageId: input.lineageId ?? null, toolName: nestedCall.name, durationMs: Math.max(0, Date.now() - nestedStartedAt), error: errorText })
              throw error
            }
          }

          const result = await this.executeTool(toolCall, {
            conversationId: input.conversationId,
            messageId: assistantMessage.id,
            streamId: input.streamId ?? null,
            rootPath: input.rootPath ?? null,
            operationMode: activeOperationMode,
            provider: input.provider,
            modelName: input.modelName,
            autoApprove: input.toolAutoApprove !== false,
            subagentReasoningEffort: input.subagentReasoningEffort,
            timeoutMs: input.toolTimeoutMs,
            signal: input.signal,
            parentToolInvocationId: invocation?.id ?? null,
            lineageId: input.lineageId ?? null,
            nestedExecutor: executeNested,
          })

          toolResultContent = toToolResultContent(result)
          modelToolResultContent = getToolResultModelContent(result)
          toolError = false

          invocation && this.toolInvocationRepo?.finish(invocation.id, { status: 'completed' })
          emit({
            type: 'tool_execution',
            status: 'completed',
            toolCallId: toolCall.id,
            toolInvocationId: invocation?.id,
            lineageId: input.lineageId ?? null,
            toolName: toolCall.name,
            durationMs: Math.max(0, Date.now() - startedAt),
          })
        } catch (error) {
          // A cancelled tool means the whole run is aborting; close ownership first.
          if (input.signal?.aborted || isAbortError(error)) {
            invocation && this.toolInvocationRepo?.finish(invocation.id, {
              status: 'aborted',
              error: 'Tool execution aborted',
            })
            emit({
              type: 'tool_execution',
              status: 'aborted',
              toolCallId: toolCall.id,
              toolInvocationId: invocation?.id,
              lineageId: input.lineageId ?? null,
              toolName: toolCall.name,
              durationMs: Math.max(0, Date.now() - startedAt),
              error: 'Tool execution aborted',
            })
            throw error
          }
          toolError = true
          toolResultContent = error instanceof Error ? error.message : String(error)
          modelToolResultContent = toolResultContent

          invocation && this.toolInvocationRepo?.finish(invocation.id, {
            status: 'failed',
            error: toolResultContent,
          })
          emit({
            type: 'tool_execution',
            status: 'failed',
            toolCallId: toolCall.id,
            toolInvocationId: invocation?.id,
            lineageId: input.lineageId ?? null,
            toolName: toolCall.name,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: toolResultContent,
          })
        }

        const toolResultBlock = {
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: toolResultContent,
          is_error: toolError,
        }

        toolResultBlocks.push(toolResultBlock)

        emit({
          type: 'chunk',
          part: 'tool_result',
          toolResult: {
            tool_use_id: toolCall.id,
            content: toolResultContent,
            is_error: toolError,
          },
        })

        history.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toModelToolResultContent(modelToolResultContent, toolCall.name),
        })
      }

      if (toolResultBlocks.length > 0) {
        const existingBlocks = parseJsonArray(assistantMessage.content_blocks)
        const updatedBlocks = [...existingBlocks, ...toolResultBlocks]

        const updatedToolCalls = assistantToolCalls.map(call => {
          const resultBlock = toolResultBlocks.find(block => block.tool_use_id === call.id)
          return {
            ...call,
            status: 'complete',
            result: resultBlock?.content,
          }
        })

        const inMemoryAssistant = {
          ...assistantMessage,
          content_blocks: JSON.stringify(updatedBlocks),
          tool_calls: JSON.stringify(updatedToolCalls),
        }

        const persistResult = await persistWithFallback({
          attemptPersist: async () => {
            const updated = this.sink.updateAssistantToolState(assistantMessage.id, {
              contentBlocks: updatedBlocks,
              toolCalls: updatedToolCalls,
            })
            if (!updated) {
              throw new Error(`Assistant message missing during tool result persist: ${assistantMessage.id}`)
            }
            return updated
          },
          conversationId: input.conversationId,
          streamId: input.streamId ?? null,
          messageId: assistantMessage.id,
          contextLabel: 'tool_loop',
          policy: this.persistencePolicy,
        })

        const assistantForContinuation = persistResult.result ?? inMemoryAssistant
        lastAssistantMessage = assistantForContinuation
        history[assistantHistoryIndex] = assistantForContinuation

        // Re-emit the merged assistant row (now carrying tool_result blocks) so SSE
        // clients can update the intermediate turn's message in place. The initial
        // assistant_message_persisted at :652 fired BEFORE tools ran, so without this
        // a thin client renders the turn without its tool results until a DB reload.
        // Clients that ignore this event (subagent transcript, mobile UI) are unaffected.
        emit({ type: 'assistant_message_persisted', message: assistantForContinuation })
      }

      // Continue the loop even when all tool calls fail. Before issuing the next
      // provider request, compact at a quiescent boundary where every requested
      // tool has executed exactly once and its result is durable.
      currentParentId = assistantMessage.id
      currentUserContent = ''

      const reportedUsage = output.contextUsage ?? usageFromMessage(lastAssistantMessage)
      const compactionDecision = resolveOpenAIContinuationCompaction({
        providerName: input.provider,
        reportedUsage,
        projectedTokens: projectedReplayTokens(input, history),
        contextLength: input.contextLength ?? openAIModelContextLength(input.modelName),
        enabled: input.autoCompactionEnabled ?? true,
        thresholdPercent: input.compactionThresholdPercent,
      })

      if (compactionDecision.shouldCompact) {
        const eventDetails = {
          turn,
          reportedTokens: compactionDecision.reportedTokens,
          projectedTokens: compactionDecision.projectedTokens,
          effectiveTokens: compactionDecision.effectiveTokens,
          contextLength: compactionDecision.contextLength,
          thresholdPercent: compactionDecision.thresholdPercent,
          parentMessageId: assistantMessage.id,
        }
        emit({ type: 'context_compaction', status: 'threshold_reached', ...eventDetails })
        emit({ type: 'context_compaction', status: 'started', ...eventDetails })

        if (!this.compactBranch) {
          const error = 'Automatic context compaction is not configured; continuation paused before context overflow.'
          emit({ type: 'context_compaction', status: 'failed', ...eventDetails, error })
          throw new Error(error)
        }

        try {
          const compacted = await this.compactBranch({
            conversationId: input.conversationId,
            parentMessageId: assistantMessage.id,
            messages: history,
            provider: input.compactionProvider || input.provider,
            modelName: input.compactionModelName || input.modelName,
            userId: input.userId,
            accessToken: input.accessToken,
            accountId: input.accountId,
            systemPrompt: input.compactionSystemPrompt,
          })
          const summaryMessage = compacted?.message
          const validSummary =
            summaryMessage?.role === 'system' &&
            summaryMessage?.note === '__auto_compaction_summary__' &&
            String(summaryMessage?.parent_id ?? '') === String(assistantMessage.id)
          if (!validSummary) throw new Error('Compaction returned an invalid branch summary marker')

          history = [summaryMessage]
          currentParentId = summaryMessage.id
          emit({
            type: 'context_compaction',
            status: 'completed',
            ...eventDetails,
            parentMessageId: summaryMessage.id,
            summaryMessage,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          emit({ type: 'context_compaction', status: 'failed', ...eventDetails, error: message })
          throw new Error(`Automatic context compaction failed; continuation paused: ${message}`)
        }
      }

      emit({
        type: 'tool_loop',
        status: 'turn_completed',
        turn,
        maxTurns,
        continued: true,
      })
    }

    emit({
      type: 'tool_loop',
      status: 'max_turns_reached',
      turn: maxTurns,
      maxTurns,
      continued: false,
    })

    // Phase 3: if a Stop hook forced continuation past the turn cap, the last turn was
    // a valid natural stop (no pending tool calls) already persisted. Finalize with it
    // instead of throwing — parity with the renderer, which exits its `while (turnCount
    // < MAX_TURNS)` loop and completes with the last message rather than erroring. The
    // tool-driven max-turns case (marker false) still falls through to the throw below,
    // where the "without a final assistant response without tool calls" wording is accurate.
    if (stopHookForcedContinue && lastAssistantMessage) {
      return {
        finalAssistantMessage: lastAssistantMessage,
        turnsUsed: maxTurns,
        anyToolsExecuted,
      }
    }

    // Recover a silent max-turns exhaustion with a summary turn when enabled.
    if (robustness?.finalizeOnSilentToolEnd && anyToolsExecuted && lastAssistantMessage) {
      return await this.runFinalizationTurn({
        input,
        history,
        parentId: currentParentId,
        turnsSoFar: maxTurns,
        maxTurns,
        anyToolsExecuted,
        emit,
      })
    }

    if (!lastAssistantMessage) {
      throw new Error('Tool loop ended without an assistant message')
    }

    throw new Error(
      `Tool loop reached max turns (${maxTurns}) without producing a final assistant response without tool calls`
    )
  }
}
