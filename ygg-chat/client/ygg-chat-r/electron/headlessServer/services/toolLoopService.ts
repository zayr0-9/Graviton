import type { HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import { ToolInvocationRepo } from '../persistence/toolInvocationRepo.js'
import { TreeMessageSink, type MessageSink } from './messageSink.js'
import type {
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderPartialOutput,
  ProviderToolCall,
  ProviderToolDefinition,
} from '../providers/openRouterProvider.js'
import { ProviderRouter, normalizeProviderRoute } from './providerRouter.js'
import { persistWithFallback, type ToolResultPersistencePolicy } from './toolResultPersistenceService.js'
import { sanitizeToolResultContentForModel } from '../providers/toolResultSanitizer.js'
import {
  attachChatErrorCode,
  classifyChatError,
  formatProviderErrorForAssistant,
  getAttachedChatErrorCode,
  isTransientProviderError,
  type FormattedProviderError,
} from '../providers/providerErrorFormatter.js'
import { buildChatErrorEnvelope, type ChatErrorCode } from '../../../../../shared/chatErrors.js'
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
  /**
   * Retry a provider turn on a TRANSIENT provider error (429 / 408 / 5xx /
   * overloaded / usage-limit / timeout) before persisting the error and failing
   * the turn. The turn counter is not advanced across retries; the error row is
   * persisted only once retries are exhausted. Off by default (main chat opts
   * out); subagents opt in.
   */
  retryProviderError?: boolean
  /** Max provider-error retries before giving up. Default 2 (=> up to 3 total attempts). */
  maxProviderRetries?: number
  /** Base backoff (ms) before a provider-error retry; multiplied by attempt, plus jitter. */
  providerRetryBackoffMs?: number
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
    // Classified at construction so every throw site (the main loop and the
    // finalization turn) carries the code; nothing downstream has to match on
    // `name` or re-parse the message.
    attachChatErrorCode(this, 'provider_empty_response', { provider: input.provider })
  }
}

const DEFAULT_MAX_TURNS = 400
const DEFAULT_PROVIDER_TURN_TIMEOUT_MS = 180_000
const EMPTY_TURN_RETRY_BASE_MS = 600
const EMPTY_TURN_RETRY_JITTER_MS = 400
const DEFAULT_MAX_PROVIDER_RETRIES = 2
const DEFAULT_PROVIDER_RETRY_BACKOFF_MS = 750
const PROVIDER_RETRY_JITTER_MS = 400
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

/**
 * `label` is part of a string that CAN reach a user: on the OpenAI path
 * `formatProviderErrorForAssistant` folds this message into the persisted assistant
 * text ("Reason: …"), because "timed out" is one of its transient patterns. So the
 * label must stay in plain user vocabulary — it must NOT carry loop internals like
 * "Provider turn 7/400". Turn context already travels structurally on the
 * `tool_loop` frames (turn / maxTurns), where the renderer can use it without
 * splicing it into prose.
 *
 * The word "timed out" is load-bearing twice over: `isTransientProviderError`
 * matches on it to allow an in-loop retry, and the formatter treats it as transient.
 */
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
      reject(
        attachChatErrorCode(new Error(`${label} timed out after ${boundedTimeoutMs}ms`), 'provider_timeout')
      )
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

const TOOL_DENIED_PATTERN = /\bdenied\b|\bdeclin(?:e|ed|es)\b|\brejected by the user\b|\buser cancell?ed\b|\bnot approved\b/
const TOOL_POLICY_PATTERN = /\bagent mode\b|\bplan mode\b|\bchat mode\b|\bnot available in\b|\bnot allowed in\b|operation mode/
const TOOL_TIMEOUT_PATTERN = /\btimed out\b|\btimeout\b|\betimedout\b/
const MCP_TRANSPORT_PATTERN =
  /\b(?:unavailable|unreachable|not connected|disconnected|no such server|failed to (?:connect|start|spawn)|connection (?:closed|refused|reset)|transport|econnrefused|econnreset|enoent|server exited)\b/

/**
 * Which failure was this, in the shared vocabulary?
 *
 * A code attached upstream always wins — `chatHookService` already tags a PreToolUse
 * `deny` as `tool_denied`, and the orchestrator tags a user Deny the same way. The
 * heuristics below only cover errors that reach us as bare prose. The distinction is
 * not cosmetic: a Deny and a Plan-mode block are the tool behaving exactly as
 * configured, and must never be presented (or styled) as a crash.
 */
function classifyToolExecutionErrorCode(error: unknown, toolName?: string | null): ChatErrorCode {
  const attached = getAttachedChatErrorCode(error)
  if (attached) return attached

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (TOOL_DENIED_PATTERN.test(message)) return 'tool_denied'
  if (TOOL_POLICY_PATTERN.test(message)) return 'tool_blocked_by_policy'
  if (TOOL_TIMEOUT_PATTERN.test(message)) return 'tool_timeout'

  const isMcpTool = typeof toolName === 'string' && toolName.startsWith('mcp__')
  if ((isMcpTool || message.includes('mcp')) && MCP_TRANSPORT_PATTERN.test(message)) return 'mcp_unavailable'

  return 'tool_failed'
}

/** What the MODEL should do next. Deliberately imperative — this is not user prose. */
function toolFailureModelGuidance(code: ChatErrorCode): string {
  switch (code) {
    case 'tool_denied':
      return 'The user declined this tool call. Do NOT call it again. Continue without it, or ask the user how to proceed.'
    case 'tool_blocked_by_policy':
      return 'This tool is not permitted in the current mode. Do NOT call it again. Continue with the tools that are available.'
    case 'tool_timeout':
      return 'This tool exceeded its time budget. Only call it again with a narrower or cheaper input.'
    case 'mcp_unavailable':
      return 'The MCP server backing this tool is unreachable. Do NOT call its tools again in this reply.'
    default:
      return 'This tool call FAILED. Do NOT repeat the identical call — change the arguments or take a different approach.'
  }
}

/**
 * State the failure inside the tool result's TEXT, because no provider on this
 * server puts the `is_error` flag on the wire:
 *
 *  - openRouter rebuilds a `role:'tool'` history entry from a fixed field list
 *    (`normalizeHistoryMessage`), which has no `is_error`;
 *  - lmStudio emits an OpenAI chat-completions `role:'tool'` message, whose schema
 *    has no failure field;
 *  - openaiChatgpt emits a Responses `function_call_output`, likewise;
 *  - hyperRouter reads tool results ONLY out of the assistant row's `content_blocks`
 *    and ignores `role:'tool'` entries entirely.
 *
 * The flag is still set on both carriers (see the call sites) for any consumer that
 * does honour it, but the text is the only channel that survives everywhere. Without
 * it a failure reaches the model as an ordinary string it reads as data, which is why
 * it happily re-issues the identical failing call.
 */
function markToolFailureForModel(content: string, code: ChatErrorCode): string {
  return `[tool_error code=${code}] ${toolFailureModelGuidance(code)}\n\n${content}`
}

/**
 * `assertToolAllowedForOperationMode` lives in shared/ and throws plain Errors.
 * Tag them at the boundary so the catch below does not have to pattern-match prose.
 */
function assertToolAllowedForOperationModeClassified(
  toolCall: ProviderToolCall,
  operationMode: 'plan' | 'execute'
): void {
  try {
    assertToolAllowedForOperationMode(toolCall, operationMode)
  } catch (error) {
    throw error && typeof error === 'object' ? attachChatErrorCode(error, 'tool_blocked_by_policy') : error
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

/** Normalized, non-empty partial. Every field is present so callers never re-guard. */
interface NormalizedPartialOutput {
  content: string
  contentBlocks: any[]
  reasoning: string
  toolCalls: ProviderToolCall[]
}

const MAX_PARTIAL_CAUSE_DEPTH = 5

/**
 * R1(a) -> R1(b): read the text/blocks/reasoning/tool calls a streaming provider had
 * already accumulated when it threw (`error.partialOutput`, set by
 * `attachPartialOutput`).
 *
 * The `cause` chain is walked because a provider throw is not always the object the
 * loop catches: a wrapper (Codex's request layer, a retry shim) can re-throw with the
 * original as `cause`, and the accumulated words must not be lost to that indirection.
 *
 * Returns null when nothing renderable was accumulated — an empty assistant row is
 * noise, and the classified failure is reported either way.
 */
function readPartialProviderOutput(error: unknown): NormalizedPartialOutput | null {
  let node: any = error
  for (let depth = 0; node && depth < MAX_PARTIAL_CAUSE_DEPTH; depth++) {
    if (typeof node === 'object' || typeof node === 'function') {
      const raw = (node as { partialOutput?: unknown }).partialOutput
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const partial = raw as ProviderPartialOutput
        const normalized: NormalizedPartialOutput = {
          content: typeof partial.content === 'string' ? partial.content : '',
          contentBlocks: Array.isArray(partial.contentBlocks) ? partial.contentBlocks : [],
          reasoning: typeof partial.reasoning === 'string' ? partial.reasoning : '',
          toolCalls: Array.isArray(partial.toolCalls) ? partial.toolCalls : [],
        }
        const renderable =
          normalized.content.trim().length > 0 ||
          normalized.reasoning.trim().length > 0 ||
          normalized.contentBlocks.length > 0 ||
          normalized.toolCalls.length > 0
        if (renderable) return normalized
      }
    }
    const next = node && typeof node === 'object' ? node.cause : undefined
    if (!next || next === node) break
    node = next
  }
  return null
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
   * R1(b) — PARTIAL TEXT IS NEVER LOST.
   *
   * Persist whatever the provider had streamed before it threw as an ORDINARY
   * assistant row: normal `content` / `content_blocks`, NO ErrorBlock, no marker,
   * nothing that says "this failed". The explanation is a SEPARATE row the
   * orchestrator writes as a CHILD of this one, so the user keeps the words and gets
   * the reason, and both survive a reload.
   *
   * Returns the persisted row (the id the ErrorBlock row parents onto), or null when
   * the throw carried nothing renderable.
   */
  private persistPartialProviderOutput(params: {
    input: ToolLoopRunInput
    parentId: string | null
    error: unknown
    emit: (event: HeadlessStreamEvent) => void
  }): any | null {
    const partial = readPartialProviderOutput(params.error)
    if (!partial) return null

    const toolCalls = partial.toolCalls
      .map(normalizeToolCall)
      .filter((call): call is ProviderToolCall => Boolean(call))
    const contentBlocks = appendGeneratedBlocks({
      content: partial.content,
      contentBlocks: partial.contentBlocks,
      reasoning: partial.reasoning || undefined,
      toolCalls,
    })

    try {
      const message = this.sink.persistAssistantMessage({
        conversationId: params.input.conversationId,
        parentId: params.parentId,
        content: partial.content,
        modelName: params.input.modelName,
        toolCalls: toolCalls.length ? toolCalls : null,
        contentBlocks,
        thinkingBlock: partial.reasoning || null,
      })
      // The live renderer adopts this row instead of throwing its stream buffer away,
      // and the orchestrator's "last persisted assistant id" tracker (which reads this
      // frame) now points at it — that id is the parent for the ErrorBlock row.
      params.emit({ type: 'assistant_message_persisted', message })
      return message
    } catch (persistError) {
      // Losing the partial is bad; losing the CLASSIFIED FAILURE because saving the
      // partial threw would be worse. Log and fall through to the rethrow.
      console.error('[ToolLoopService] failed to persist partial provider output', persistError)
      return null
    }
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
    /**
     * R1(b): the loop's "last persisted assistant id" tracker. Called with the partial
     * row persisted on a mid-stream provider failure so `run`'s own `lastAssistantMessage`
     * agrees with the `assistant_message_persisted` frame the orchestrator tracks.
     */
    recordAssistant?: (message: any) => void
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

    const maxProviderRetries = input.robustness?.retryProviderError
      ? Math.max(0, input.robustness.maxProviderRetries ?? DEFAULT_MAX_PROVIDER_RETRIES)
      : 0

    // Attempt loop for TRANSIENT provider errors (opt-in via robustness). On a
    // retryable failure we back off and re-issue the SAME turn — WITHOUT persisting
    // an error row and WITHOUT advancing the turn counter. The error is persisted
    // and thrown only once retries are exhausted (or immediately when disabled /
    // the error is not transient). for(;;) exits only via return or throw.
    for (let attempt = 1; ; attempt++) {
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
          // NOT `Provider turn ${turn}/${maxTurns}` any more: on the OpenAI path that
          // label was folded verbatim into the persisted assistant text, which is how
          // "Provider turn 7/400" reached the screen.
          'The model provider',
          input.signal
        )
      } catch (error) {
        // Cancellation is not a provider failure; propagate it so the run aborts cleanly.
        if (input.signal?.aborted || isAbortError(error)) {
          throw error
        }

        // Transient failure with retries left: back off and try the same turn again.
        // Deferred persistence — nothing is written until retries are exhausted, and
        // this attempt's partial output is deliberately dropped: the re-issued turn
        // regenerates it, so persisting it here would duplicate the answer.
        if (attempt <= maxProviderRetries && isTransientProviderError(error)) {
          // Two frames, one per audience. `tool_loop` is the machine-readable record;
          // `notice` is the user-visible one. The LOOP owns the prose for all three
          // silences it can cause (retrying / max_turns_reached / compacting) and
          // `sseProjection` projects only the `notice` — so the two cannot drift into
          // either showing the backoff twice or, as happened here, not at all.
          emit({
            type: 'tool_loop',
            status: 'provider_retry',
            turn,
            maxTurns,
            attempt,
            maxAttempts: maxProviderRetries,
          })
          emit({
            type: 'notice',
            code: 'retrying',
            message: 'That did not go through. Trying again…',
            attempt,
            maxAttempts: maxProviderRetries,
            lineageId: input.lineageId ?? null,
          })
          const base = input.robustness?.providerRetryBackoffMs ?? DEFAULT_PROVIDER_RETRY_BACKOFF_MS
          // Rejects with AbortError if the run is cancelled mid-backoff -> propagates.
          await abortAwareSleep(base * attempt + Math.floor(Math.random() * PROVIDER_RETRY_JITTER_MS), input.signal)
          continue
        }

        // R1(b): retries are exhausted (or disabled) — this failure is real, so keep
        // whatever the provider already streamed. Persisted BEFORE the rethrow so the
        // row exists by the time the orchestrator writes its ErrorBlock child.
        const partialAssistantMessage = this.persistPartialProviderOutput({
          input,
          parentId: params.parentId,
          error,
          emit,
        })
        if (partialAssistantMessage) params.recordAssistant?.(partialAssistantMessage)

        const providerError = formatProviderErrorForAssistant(error, {
          provider: input.provider,
          modelName: input.modelName,
        })

        // A code attached at the throw site (a turn timeout) is more specific than
        // anything the formatter's prose can be re-parsed into — carry it through.
        const attachedCode = getAttachedChatErrorCode(error)

        if (providerError) {
          // The legacy human prose ("Reason: …", "HTTP status: 429", "Error type:
          // usage_limit_reached") is NO LONGER persisted as an assistant message and no
          // longer streamed as a text chunk. It read as if the MODEL had said it, and it
          // said the same thing as the ErrorBlock row the orchestrator writes for this
          // same failure — exactly ONE assistant row may carry the explanation, and that
          // row is the orchestrator's. The prose survives as `envelope.detail`, which is
          // technical text that is never rendered on its own; `envelope.userMessage`
          // remains the only string a user reads.
          //
          // `assistantMessage` is now the D1 partial (or null when nothing was streamed).
          // The orchestrator parents its ErrorBlock row on `assistantMessage?.id ??
          // lastPersistedAssistantId ?? assistantParentId`, so both cases land correctly.
          const wrapped = new ProviderErrorAssistantResponse({
            assistantMessage: partialAssistantMessage,
            providerError: providerError.envelope
              ? { ...providerError, envelope: { ...providerError.envelope, detail: providerError.message } }
              : providerError,
            turnsUsed: turn,
          })
          throw attachedCode ? attachChatErrorCode(wrapped, attachedCode, { provider: input.provider }) : wrapped
        }

        // No `error` frame here any more. The orchestrator/route owns the single
        // terminal frame for this exception; emitting one here as well produced TWO
        // terminal frames for one failure (and the second one leaked "Continuation
        // generation failed on turn 7/400" into user-facing prose). A notice would be
        // pure noise: this rethrow is immediately followed by the owner's frame,
        // saying the same thing with a proper envelope. Instead, classify the error
        // once, here, so that owner never has to re-parse the message text. Turn
        // context is already on the `tool_loop` frames.
        if (error && typeof error === 'object' && !attachedCode) {
          const envelope = classifyChatError(error, {
            provider: input.provider,
            modelName: input.modelName,
            phase: 'provider',
          })
          attachChatErrorCode(error, envelope.code, envelope)
        }
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
    /** Forwarded to generateProviderTurn so an R1(b) partial updates the loop's tracker. */
    recordAssistant?: (message: any) => void
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
      recordAssistant: params.recordAssistant,
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
    // The loop's "last persisted assistant id" tracker. R1(b): a partial persisted on a
    // mid-stream provider failure must land here too, so this and the
    // `assistant_message_persisted` frame the orchestrator tracks never disagree about
    // which row an ErrorBlock should hang off.
    const recordAssistant = (message: any) => {
      if (message) lastAssistantMessage = message
    }
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
        recordAssistant,
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
      // The same blocks, but with failures stated in the text. Kept separate so the
      // PERSISTED result (and therefore the tool card, the MCP-app bridge and the
      // hook payload) still shows exactly what the tool said, while the copy replayed
      // to the model says that it failed. See markToolFailureForModel.
      const modelToolResultBlocks: any[] = []

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
        let toolErrorCode: ChatErrorCode | null = null
        const startedAt = Date.now()

        try {
          if (requiresAgentMode(toolCall, activeOperationMode)) {
            const upgraded = await input.requestOperationModeUpgrade?.(toolCall)
            if (!upgraded) {
              // The user declined, OR no upgrade handler is wired at all (subagents
              // never wire one, and chatOrchestrator only does when a decisionBroker
              // and streamId exist). Either way: the tool must NOT run, and the run
              // must STAY in plan mode.
              //
              // assertToolAllowedForOperationMode alone is NOT sufficient here — it
              // throws only for CHAT_MODE_BLOCKED_TOOL_NAMES and `mcp__*`, whereas
              // requiresAgentMode is true for anything outside the plan allow list.
              // A tool in neither set (html_renderer, theme_manager, any custom tool)
              // used to fall straight through: it executed AND promoted
              // activeOperationMode to 'execute' for the remainder of the run, with no
              // user consent and no event emitted. Assert first so blocked/mcp tools
              // keep their specific message, then fail closed for everything else.
              assertToolAllowedForOperationModeClassified(toolCall, activeOperationMode)
              throw attachChatErrorCode(
                new Error(
                  `Tool "${toolCall.name}" is not available in Chat Mode. Switch to Agent Mode to run tools that can modify files, system state, or app state.`
                ),
                'tool_blocked_by_policy'
              )
            }
            activeOperationMode = 'execute'
            input.systemPrompt = input.agentSystemPrompt ?? input.systemPrompt
          }
          assertToolAllowedForOperationModeClassified(toolCall, activeOperationMode)

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
          // Classify BEFORE the result is built: a Deny and a Plan-mode block are the
          // system working as configured, not a crash, and the code is what lets every
          // downstream reader say so without pattern-matching this message.
          toolErrorCode = classifyToolExecutionErrorCode(error, toolCall.name)
          if (error && typeof error === 'object') attachChatErrorCode(error, toolErrorCode)
          toolResultContent = error instanceof Error ? error.message : String(error)
          modelToolResultContent = markToolFailureForModel(toolResultContent, toolErrorCode)

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
          // Additive: WHY it failed, in the shared vocabulary. `is_error` alone cannot
          // distinguish "you declined this" from "this tool crashed", so a Deny used to
          // be styled identically to a crash.
          ...(toolErrorCode ? { error_code: toolErrorCode } : {}),
        }

        toolResultBlocks.push(toolResultBlock)
        modelToolResultBlocks.push(
          toolError ? { ...toolResultBlock, content: markToolFailureForModel(toolResultContent, toolErrorCode!) } : toolResultBlock
        )

        emit({
          type: 'chunk',
          part: 'tool_result',
          toolResult: {
            tool_use_id: toolCall.id,
            content: toolResultContent,
            is_error: toolError,
            ...(toolErrorCode ? { error_code: toolErrorCode } : {}),
          },
        })

        history.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toModelToolResultContent(modelToolResultContent, toolCall.name),
          // Set for any consumer that honours it. Every provider in this repo drops it
          // when it serialises a `role:'tool'` entry, which is exactly why the failure
          // is also stated in `content` — see markToolFailureForModel.
          is_error: toolError,
          ...(toolErrorCode ? { error_code: toolErrorCode } : {}),
        } as any)
      }

      if (toolResultBlocks.length > 0) {
        const existingBlocks = parseJsonArray(assistantMessage.content_blocks)
        const updatedBlocks = [...existingBlocks, ...toolResultBlocks]
        const anyToolErrors = toolResultBlocks.some(block => block.is_error)

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
        // openaiChatgpt and lmStudio build their tool outputs from the assistant row's
        // content_blocks (codex even de-dupes the matching `role:'tool'` entry away),
        // and hyperRouter reads ONLY the blocks. So when a tool failed, the copy of the
        // row that is REPLAYED to the model carries the marked blocks; the persisted
        // row, the returned message and the SSE frame keep the tool's own text.
        history[assistantHistoryIndex] = anyToolErrors
          ? { ...assistantForContinuation, content_blocks: JSON.stringify([...existingBlocks, ...modelToolResultBlocks]) }
          : assistantForContinuation

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
        // In-loop compaction is a whole extra model call. Without this the run just
        // goes quiet mid-answer, which reads as a hang.
        emit({
          type: 'notice',
          code: 'compacting',
          message: 'This conversation is getting long — summarising it so I can keep going.',
          lineageId: input.lineageId ?? null,
        })

        if (!this.compactBranch) {
          const error = 'Automatic context compaction is not configured; continuation paused before context overflow.'
          emit({ type: 'context_compaction', status: 'failed', ...eventDetails, error })
          throw attachChatErrorCode(new Error(error), 'compaction_failed')
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
          throw attachChatErrorCode(
            new Error(`Automatic context compaction failed; continuation paused: ${message}`),
            'compaction_failed',
            { detail: message }
          )
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
    // Non-terminal on purpose: the branches below may still finalize successfully.
    // The prose comes from the shared table so the notice and the error bubble that
    // may follow it cannot drift apart.
    emit({
      type: 'notice',
      code: 'max_turns_reached',
      message: buildChatErrorEnvelope('max_turns_reached').userMessage,
      attempt: maxTurns,
      maxAttempts: maxTurns,
      lineageId: input.lineageId ?? null,
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
      throw attachChatErrorCode(new Error('Tool loop ended without an assistant message'), 'internal_error')
    }

    // The message stays as-is (callers and tests match on it); the code is what the
    // orchestrator reads. "max turns (400)" is loop vocabulary and must not reach the
    // bubble — the envelope's own prose does.
    throw attachChatErrorCode(
      new Error(`Tool loop reached max turns (${maxTurns}) without producing a final assistant response without tool calls`),
      'max_turns_reached'
    )
  }
}
