import { v4 as uuidv4 } from 'uuid'
import type { HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { buildChatErrorEnvelope, type ChatErrorEnvelope } from '../../../../../shared/chatErrors.js'
import { ConversationRepo } from '../persistence/conversationRepo.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import { ProjectRepo } from '../persistence/projectRepo.js'
import { StreamingRunRepo } from '../persistence/streamingRunRepo.js'
import { LineageRepo, type LineageRow } from '../persistence/lineageRepo.js'
import { ToolInvocationRepo } from '../persistence/toolInvocationRepo.js'
import { TreeMessageSink, CloudMirrorSink, type MessageSink } from './messageSink.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import { BranchOrchestrator, type ResolvedExecution } from './branchOrchestrator.js'
import { buildHeadlessSystemPrompt } from './headlessSystemPrompt.js'
import { ProviderRouter, normalizeProviderRoute } from './providerRouter.js'
import { classifyChatError } from '../providers/providerErrorFormatter.js'
import { RailwayAppAuthError } from '../providers/openRouterProvider.js'
import {
  ProviderErrorAssistantResponse,
  ToolLoopService,
  type ToolExecutor,
  type ToolLoopCompactor,
  type ToolLoopRunResult,
} from './toolLoopService.js'
import type { DecisionBroker, ClarifyDecision, PermissionDecision } from './decisionBroker.js'
import { createChatHookSession, type ChatHookSession } from './chatHookService.js'
import { trimHistoryToLatestCompaction } from './compactionService.js'
import type { HookRunRequest, HookRunResult } from '../../hooks/hookTypes.js'
import { filterToolsForOperationMode } from '../../../../../shared/operationModeToolPolicy.js'

interface ChatOrchestratorDeps {
  db: any
  statements: any
  tokenStore?: ProviderTokenStore
  providerRouter?: ProviderRouter
  branchOrchestrator?: BranchOrchestrator
  toolLoopService?: ToolLoopService
  toolExecutor?: ToolExecutor
  defaultToolsProvider?: () => Array<{ name: string; description?: string; inputSchema?: Record<string, any> }>
  compactBranch?: ToolLoopCompactor
  /** Shared pause/resume registry. When present (with toolExecutor), enables the
   *  interactive permission / plan_md-clarify pause via a per-run wrapping executor. */
  decisionBroker?: DecisionBroker
  /** In-process hook runner (runHookRequest). When present AND request.hooksEnabled
   *  AND a decisionBroker is wired, the run fires the 5 lifecycle chat hooks
   *  (parity with the renderer). Absent for subagents/tests => NO hooks. */
  hookRunner?: (req: HookRunRequest) => Promise<HookRunResult>
  /** Phase 4 gateway.chat flag. When true, the openrouter (cloud) route relays
   *  free-tier SSE events and adopts Railway message ids (CloudMirrorSink). Default
   *  false => the cloud route behaves exactly as before (drop frames, mint ids). */
  cloudChatEnabled?: boolean
}

/** Tools that never prompt for permission (mirrors the renderer TOOL_PERMISSION_ALWAYS_BYPASS). */
const ALWAYS_BYPASS_TOOLS = new Set(['skill_manager', 'mcp_manager', 'multi_call'])
/** custom_tool_manager actions that are read-only/management (bypass) vs 'invoke' (prompt). */
const CUSTOM_TOOL_MANAGER_BYPASS_ACTIONS = new Set([
  'list',
  'get',
  'enable',
  'disable',
  'add',
  'remove',
  'reload',
  'settings',
])

function parseToolArgs(raw: unknown): any {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return raw ?? {}
}

/** Whether a tool call skips the interactive permission prompt (server-side port of the renderer gate). */
function shouldBypassPermission(toolName: string, args: any): boolean {
  if (ALWAYS_BYPASS_TOOLS.has(toolName)) return true
  if (toolName === 'custom_tool_manager') {
    // Normalize identically to the renderer (chatActions shouldBypassToolPermission)
    // so mixed-case/whitespace actions bypass on both sides.
    const action = (typeof args?.action === 'string' ? args.action : '').trim().toLowerCase()
    return action !== 'invoke' && CUSTOM_TOOL_MANAGER_BYPASS_ACTIONS.has(action)
  }
  return false
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/** The phases `classifyChatError` understands. Tracked through a run so the outer catch can say where it broke. */
type ChatErrorPhase = 'provider' | 'tool' | 'hook' | 'compaction' | 'lifecycle' | 'transport'

/**
 * The property `ChatOrchestrator` stamps on an error it rethrows AFTER it has already
 * emitted its own classified `{type:'error', envelope, terminal:true}` frame.
 *
 * This orchestrator is the SINGLE terminal-frame authority for a chat run: it classifies
 * once, persists once, and emits exactly one terminal frame. Because it still rethrows
 * (callers log, and `chatRoutes` keeps its own fallback for exceptions that never reached
 * `runMessage`), the route needs a way to tell "already published" from "never classified".
 * `chatRoutes.orchestratorAlreadyPublished` reads this exact property name.
 */
export const CHAT_ERROR_PUBLISHED_PROPERTY = 'chatErrorPublished' as const

/**
 * Out-of-band record of "already published", for errors that cannot be written to.
 *
 * This module compiles to ESM, which is always strict mode, so assigning to a frozen /
 * sealed / non-extensible error THROWS a TypeError. That throw would escape the catch
 * block that is reporting the real failure and replace it with a bogus one — the worst
 * possible substitution. The WeakSet is therefore the authority; the own properties are
 * still set best-effort because `chatRoutes.orchestratorAlreadyPublished` reads the
 * property by name (it may see an error that crossed a module/realm boundary).
 */
const publishedChatErrors = new WeakSet<object>()

/** Stamp the marker (and the envelope, for logs) on a rethrown error. Non-objects are wrapped by the caller. */
export function markChatErrorPublished<E>(error: E, envelope: ChatErrorEnvelope): E {
  if (error && typeof error === 'object') {
    publishedChatErrors.add(error as object)
    try {
      ;(error as any)[CHAT_ERROR_PUBLISHED_PROPERTY] = true
      ;(error as any).chatErrorEnvelope = envelope
    } catch {
      // Frozen/sealed error: the WeakSet above already recorded it, and losing the
      // property is infinitely better than losing the failure being reported.
    }
  }
  return error
}

/** True when the orchestrator already published a terminal frame for this error. */
export function hasPublishedChatErrorFrame(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (publishedChatErrors.has(error as object)) return true
  return (error as any)[CHAT_ERROR_PUBLISHED_PROPERTY] === true
}

/** Best-effort own-property write that can never turn a report into a different failure. */
function safeAssign(target: unknown, key: string, value: unknown): void {
  if (!target || typeof target !== 'object') return
  try {
    ;(target as any)[key] = value
  } catch {
    // Non-extensible target; the field is diagnostic only.
  }
}

/**
 * The persisted form of a classified failure (renderer `ErrorBlock`). It is the ONLY
 * block type carrying `excludeFromContext`, because replaying "I couldn't reach the
 * provider" to the model as its own prior words is a real correctness bug.
 */
export interface ErrorContentBlock {
  type: 'error'
  index: number
  envelope: ChatErrorEnvelope
  excludeFromContext: true
}

export function buildErrorContentBlock(envelope: ChatErrorEnvelope, index = 0): ErrorContentBlock {
  return { type: 'error', index, envelope, excludeFromContext: true }
}

/** `content_blocks` is a JSON string on a DB row and an array in memory; tolerate both. */
function parseContentBlocks(value: unknown): any[] | null {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Drop every `excludeFromContext` block before history reaches the model.
 *
 * An error-only assistant row (what a terminal failure persists) disappears entirely;
 * a hypothetical mixed row keeps its other blocks and is re-serialised in the same
 * shape it arrived in. Everything else passes through by reference, so the non-error
 * path is untouched.
 */
export function excludeContextExcludedMessages(messages: any[]): any[] {
  const kept: any[] = []
  for (const message of messages) {
    const blocks = parseContentBlocks(message?.content_blocks)
    if (!blocks || blocks.length === 0) {
      kept.push(message)
      continue
    }
    const visible = blocks.filter(block => block?.excludeFromContext !== true)
    if (visible.length === blocks.length) {
      kept.push(message)
      continue
    }
    if (visible.length === 0) continue
    kept.push({
      ...message,
      content_blocks: typeof message.content_blocks === 'string' ? JSON.stringify(visible) : visible,
    })
  }
  return kept
}

/**
 * The envelope for a cancelled run.
 *
 * A user Stop and a reaper eviction are INDISTINGUISHABLE today: `RunSession.cancel()`
 * calls `aborter.abort()` with no reason, so `signal.reason` is the default
 * `AbortError` DOMException for both. The reason is read defensively here so that the
 * day a caller aborts with `{ kind: 'reaper' }` (or any string mentioning reap/expire)
 * this maps to `run_expired` without another change; until then every cancel is
 * `cancelled` ("This reply was cancelled.").
 */
export function buildCancellationEnvelope(signal?: AbortSignal): ChatErrorEnvelope {
  const reason = (signal as { reason?: unknown } | undefined)?.reason
  const kind =
    typeof reason === 'string'
      ? reason
      : typeof (reason as { kind?: unknown })?.kind === 'string'
        ? ((reason as { kind: string }).kind)
        : typeof (reason as { name?: unknown })?.name === 'string'
          ? ((reason as { name: string }).name)
          : ''
  const lowered = kind.toLowerCase()
  if (lowered.includes('reap') || lowered.includes('expire')) {
    return buildChatErrorEnvelope('run_expired', { detail: `Run cancelled: ${kind}` })
  }
  return buildChatErrorEnvelope('cancelled', { detail: 'Run aborted' })
}

export function shouldRejectSourceLineageMismatch(
  requestedLineageId: string | null | undefined,
  sourceInLineagePath: boolean
): boolean {
  return Boolean(requestedLineageId) && !sourceInLineagePath
}

/**
 * Build a per-run tool executor that pauses for interactive decisions (permission /
 * plan_md clarify) via the DecisionBroker and — when a hookSession is supplied —
 * interleaves the PreToolUse/PostToolUse/PostToolUseFailure chat hooks around the
 * permission gate. Extracted from ChatOrchestrator so the interleave is unit-testable
 * without the persistence layer. Behavior with `hookSession` undefined is the exact
 * Phase-2 path, byte-for-byte.
 */
export function createChatPausingExecutor(deps: {
  base: ToolExecutor
  broker: DecisionBroker
  streamId: string
  emit: (event: HeadlessStreamEvent) => void
  signal?: AbortSignal
  hookSession?: ChatHookSession
}): ToolExecutor {
  const { base, broker, streamId, emit, signal, hookSession } = deps
  const execute: ToolExecutor = async (toolCall, context) => {
    const sig = context.signal ?? signal
    const args = parseToolArgs(toolCall.arguments)

    // plan_md clarify is INHERENTLY interactive: the base executor always throws on it
    // (planMd.ts), so it is intercepted here and routed through the DecisionBroker's
    // clarify channel instead of executed. `call`/`cArgs` are the effective (possibly
    // hook-rewritten) call so a PreToolUse updatedInput reaches the clarify questions.
    const runClarify = async (call: typeof toolCall, cArgs: any) => {
      emit({
        type: 'clarify_required',
        streamId,
        toolCallId: toolCall.id,
        toolName: call.name,
        questions: Array.isArray(cArgs?.questions) ? cArgs.questions : [],
      })
      const decision = await broker.requestDecision<ClarifyDecision>({ streamId, toolCallId: toolCall.id, signal: sig })
      return {
        clarified: !decision.cancelled,
        cancelled: decision.cancelled ?? false,
        questions: Array.isArray(cArgs?.questions) ? cArgs.questions.length : 0,
        answers: decision.answers ?? [],
      }
    }
    const isClarify = (name: string | undefined, a: any) => name === 'plan_md' && a?.action === 'clarify'

    // No hooks: the exact Phase-2 path, byte-for-byte. Clarify is intercepted before
    // the auto-approve short-circuit (auto-approve only skips permission PROMPTS, not
    // the clarify mechanism).
    if (!hookSession) {
      if (isClarify(toolCall.name, args)) return runClarify(toolCall, args)
      if (broker.isAutoApproveAll(streamId)) return base(toolCall, { ...context, nestedExecutor: context.nestedExecutor ?? execute })
      if (shouldBypassPermission(toolCall.name, args)) return base(toolCall, { ...context, nestedExecutor: context.nestedExecutor ?? execute })
      emit({ type: 'permission_required', streamId, toolCallId: toolCall.id, toolName: toolCall.name, toolInput: args })
      const decision = await broker.requestDecision<PermissionDecision>({ streamId, toolCallId: toolCall.id, signal: sig })
      if (decision === 'deny') throw new Error('Tool execution denied by user')
      if (decision === 'allow_always') broker.setAutoApproveAll(streamId)
      return base(toolCall, { ...context, nestedExecutor: context.nestedExecutor ?? execute })
    }

    // Hooks active — port of the renderer executeToolWithPermissionCheck
    // (chatActions.ts:2406-2522): PreToolUse (BEFORE any prompt/clarify; may rewrite
    // args or deny) -> [clarify OR permission gate + execute] -> PostToolUse /
    // PostToolUseFailure. A SINGLE try/catch so a PreToolUse deny AND a permission deny
    // both fire PostToolUseFailure, matching the renderer's single catch. Clarify runs
    // INSIDE the hook wrapper (parity: the renderer intercepts clarify in the base
    // executor, under executeToolWithPermissionCheck, so Pre/Post DO fire around it).
    let effectiveToolCall = toolCall
    try {
      const pre = await hookSession.runPreToolUse(toolCall, context)
      if (pre.updatedInput) effectiveToolCall = { ...toolCall, arguments: pre.updatedInput }
      if (pre.permissionDecision === 'deny') {
        throw new Error(pre.permissionDecisionReason || 'Tool blocked by hook')
      }
      const effArgs = parseToolArgs(effectiveToolCall.arguments)

      let result: any
      if (isClarify(effectiveToolCall.name, effArgs)) {
        // Clarify bypasses the permission prompt (its own interactive channel), but
        // still fires PostToolUse — same as the renderer.
        result = await runClarify(effectiveToolCall, effArgs)
      } else if (broker.isAutoApproveAll(streamId) || shouldBypassPermission(effectiveToolCall.name, effArgs)) {
        result = await base(effectiveToolCall, { ...context, nestedExecutor: context.nestedExecutor ?? execute })
      } else {
        // Prompt shows the rewritten args. toolCallId stays the original id (a rewrite
        // only touches arguments), so the /resume correlation is unchanged.
        emit({ type: 'permission_required', streamId, toolCallId: toolCall.id, toolName: effectiveToolCall.name, toolInput: effArgs })
        const decision = await broker.requestDecision<PermissionDecision>({ streamId, toolCallId: toolCall.id, signal: sig })
        if (decision === 'deny') throw new Error('Tool execution denied by user')
        if (decision === 'allow_always') broker.setAutoApproveAll(streamId)
        result = await base(effectiveToolCall, { ...context, nestedExecutor: context.nestedExecutor ?? execute })
      }

      await hookSession.runPostToolUse(effectiveToolCall, result, context)
      return result
    } catch (error) {
      // Abort escapes unwrapped to preserve the loop's clean cancellation unwind
      // (toolLoopService rethrows aborts); no PostToolUseFailure on cancel — a
      // deliberate, documented divergence from the renderer (which fires it on any error).
      if (sig?.aborted || isAbortError(error)) throw error
      await hookSession.runPostToolUseFailure(effectiveToolCall, error, context)
      throw error
    }
  }
  return execute
}

export interface HeadlessChatOrchestrator {
  /**
   * Run one chat turn to completion.
   *
   * TERMINAL-FRAME CONTRACT: `runMessage` is the single authority for a run's ending.
   * It emits EXACTLY ONE terminal frame — `{type:'complete'}` on success (or on the
   * provider-error-as-assistant-response path, badged with `providerError`+`envelope`)
   * or `{type:'error', envelope, terminal:true}` on any failure, INCLUDING an abort.
   * It still rethrows non-abort failures, stamped with `chatErrorPublished: true`
   * (see `markChatErrorPublished` / `hasPublishedChatErrorFrame`) so a caller can log
   * without publishing a second, worse frame over the classified one.
   */
  runMessage(
    request: HeadlessMessageRequest,
    emit: (event: HeadlessStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void>
}

export class ChatOrchestrator implements HeadlessChatOrchestrator {
  private readonly statements: any
  private readonly conversationRepo: ConversationRepo
  private readonly messageRepo: MessageRepo
  private readonly projectRepo: ProjectRepo
  private readonly streamingRunRepo: StreamingRunRepo
  private readonly lineageRepo: LineageRepo
  private readonly providerRouter: ProviderRouter
  private readonly branchOrchestrator: BranchOrchestrator
  private readonly toolLoopService: ToolLoopService
  private readonly defaultToolsProvider: NonNullable<ChatOrchestratorDeps['defaultToolsProvider']>
  // Kept as fields so runMessage can build a per-run ToolLoopService with a
  // run-scoped pausing executor (mirrors SubagentRunService.countingExecutor).
  private readonly toolExecutor?: ToolExecutor
  private readonly compactBranch?: ToolLoopCompactor
  private readonly decisionBroker?: DecisionBroker
  private readonly hookRunner?: (req: HookRunRequest) => Promise<HookRunResult>
  private readonly cloudChatEnabled: boolean

  constructor(deps: ChatOrchestratorDeps) {
    this.statements = deps.statements
    this.conversationRepo = new ConversationRepo({ db: deps.db, statements: deps.statements })
    this.messageRepo = new MessageRepo({ db: deps.db, statements: deps.statements })
    this.projectRepo = new ProjectRepo({ db: deps.db })
    this.streamingRunRepo = new StreamingRunRepo({ statements: deps.statements })
    this.lineageRepo = new LineageRepo({ db: deps.db, statements: deps.statements })
    this.providerRouter = deps.providerRouter ?? new ProviderRouter({ tokenStore: deps.tokenStore })
    this.branchOrchestrator = deps.branchOrchestrator ?? new BranchOrchestrator()
    this.toolExecutor = deps.toolExecutor
    this.compactBranch = deps.compactBranch
    this.decisionBroker = deps.decisionBroker
    this.hookRunner = deps.hookRunner
    this.cloudChatEnabled = deps.cloudChatEnabled ?? false
    this.toolLoopService =
      deps.toolLoopService ??
      new ToolLoopService({
        sink: new TreeMessageSink({ messageRepo: this.messageRepo }),
        providerRouter: this.providerRouter,
        executeTool: deps.toolExecutor,
        compactBranch: deps.compactBranch,
      })
    this.defaultToolsProvider = deps.defaultToolsProvider ?? (() => [])
  }

  /**
   * Build a per-run executor that pauses for an interactive permission decision
   * (or a plan_md clarify) via the DecisionBroker before delegating to the base
   * executor. Mirrors SubagentRunService.countingExecutor. Only used when a broker
   * + base executor are wired AND the run's session is not auto-approve.
   */
  private makePausingExecutor(
    streamId: string,
    emit: (event: HeadlessStreamEvent) => void,
    signal?: AbortSignal,
    hookSession?: ChatHookSession
  ): ToolExecutor {
    return createChatPausingExecutor({
      base: this.toolExecutor!,
      broker: this.decisionBroker!,
      streamId,
      emit,
      signal,
      hookSession,
    })
  }

  /**
   * Classify once, and guarantee the raw text lands in `detail` — NEVER in
   * `userMessage`. `classifyChatError` always returns a complete envelope; this only
   * fills the two fields the orchestrator knows better than the classifier does.
   */
  private classifyRunError(
    error: unknown,
    context: { provider?: string; modelName?: string; phase: ChatErrorPhase }
  ): ChatErrorEnvelope {
    const raw = error instanceof Error ? error.message : String(error)
    const classified = classifyChatError(error, context)
    return buildChatErrorEnvelope(classified.code, {
      userMessage: classified.userMessage,
      recoverability: classified.recoverability,
      action: classified.action,
      retryAfterMs: classified.retryAfterMs,
      resetAt: classified.resetAt,
      detail: classified.detail ?? raw,
      provider: classified.provider ?? context.provider,
      status: classified.status,
    })
  }

  /**
   * Decision D1. Persist the classified failure as its OWN assistant message so it
   * survives a reload and renders like any other bubble.
   *
   * The partial assistant message the loop already wrote is never touched — the error
   * row is a NEW child of it, so `user -> partial -> error` is the tree shape. The row
   * is written through the RUN'S sink, so it gets the same lineage bookkeeping (append,
   * or materialize a still-pending fork) as a normal turn.
   *
   * A persistence failure here must never mask the failure being reported, so it is
   * swallowed after logging; the terminal frame is emitted either way.
   */
  private persistErrorAssistantMessage(params: {
    sink: MessageSink | null
    conversationId: string
    parentId: string | null
    modelName?: string | null
    envelope: ChatErrorEnvelope
    lineageId: string | null
    emit: (event: HeadlessStreamEvent) => void
  }): any | null {
    if (!params.sink) return null
    try {
      const message = params.sink.persistAssistantMessage({
        conversationId: params.conversationId,
        parentId: params.parentId,
        // `content` mirrors the ONE user-facing string so exports/search/tree views
        // that never learned about blocks still read sensibly. The block is the
        // structured form the renderer draws (and the only one carrying the action).
        content: params.envelope.userMessage,
        modelName: params.modelName ?? null,
        contentBlocks: [buildErrorContentBlock(params.envelope)],
      })
      params.emit({ type: 'assistant_message_persisted', message, lineageId: params.lineageId })
      return message
    } catch (persistError) {
      console.error('[ChatOrchestrator] failed to persist error block message', persistError)
      return null
    }
  }

  private requireMessage(messageId: string, conversationId: string): any {
    const message = this.conversationRepo.getMessageById(messageId)
    if (!message || message.conversation_id !== conversationId) {
      throw new Error(`Message not found in conversation: ${messageId}`)
    }
    return message
  }

  private createUserMessage(request: HeadlessMessageRequest, parentId: string | null, content: string): any {
    return this.messageRepo.createMessage({
      conversationId: request.conversationId,
      parentId,
      role: 'user',
      content,
      modelName: request.modelName,
      contentBlocks: null,
    })
  }

  private resolveExecution(request: HeadlessMessageRequest): ResolvedExecution {
    return this.branchOrchestrator.resolve(request, {
      requireMessage: (messageId, conversationId) => this.requireMessage(messageId, conversationId),
      createUserMessage: (parentId, content) => this.createUserMessage(request, parentId, content),
      findNearestUserAncestor: (messageId, conversationId) =>
        this.conversationRepo.findNearestUserAncestor(conversationId, messageId),
    })
  }

  async runMessage(
    request: HeadlessMessageRequest,
    emit: (event: HeadlessStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    // Mint the stream id BEFORE any persistence so `started` — and every terminal frame
    // a pre-persist failure produces — carries the id the client reconnects with.
    // `streamingRunRepo.upsert` adopts a supplied id verbatim, so the row is unchanged.
    let trackedStreamId = request.streamId || uuidv4()
    // ── Run state hoisted for the outer catch: it is the single terminal-frame authority
    // and needs to know where the run got to before it broke. ──
    /** Where the run was when it threw; the hint handed to `classifyChatError`. */
    let phase: ChatErrorPhase = 'lifecycle'
    /** Guards the invariant "no terminal frame without a preceding `started`". */
    let startedEmitted = false
    let trackedLineageId: string | null = null
    /** The assistant turn's parent — the fallback parent for a D1 error row. */
    let assistantParentId: string | null = null
    /** Last assistant row the LOOP persisted: the D1 partial the error row hangs off. */
    let lastPersistedAssistantId: string | null = null
    /** The run's message sink; null until the user message + lineage exist. */
    let runSink: MessageSink | null = null
    /** Terminal frames must never throw out of the catch (a disconnected SSE socket). */
    const safeEmit = (event: HeadlessStreamEvent) => {
      try {
        emit(event)
      } catch (emitError) {
        console.error('[ChatOrchestrator] failed to emit terminal frame', emitError)
      }
    }
    try {
    const conversation = this.conversationRepo.getById(request.conversationId)
    if (!conversation) {
      throw new Error(`Conversation not found: ${request.conversationId}`)
    }

    const now = new Date().toISOString()
    this.conversationRepo.touch(request.conversationId, now)
    if (conversation.project_id) {
      this.projectRepo.touch(conversation.project_id, now)
    }

    // Hoisted above resolveExecution so the hook session can carry project context and
    // run UserPromptSubmit before the user message is persisted. Reused below for the
    // system prompt / projectContext (was fetched inline there previously).
    const project = conversation.project_id ? this.projectRepo.getById(conversation.project_id) : null

    // Phase 3: build a per-run chat-hook session when a hook runner is wired, the
    // request opted in, AND the interactive (broker) path is active — hooks live on the
    // pausing executor, so they require the broker. Absent for subagents/mobile/tests.
    const hookSession =
      this.hookRunner && request.hooksEnabled === true && this.decisionBroker
        ? createChatHookSession({
            conversationRepo: this.conversationRepo,
            runHook: this.hookRunner,
            conversationId: request.conversationId,
            cwd: request.rootPath ?? conversation.cwd ?? null,
            provider: request.provider,
            model: request.modelName,
            operation: request.operation,
            streamId: trackedStreamId,
            project: { projectId: project?.id ?? null, projectName: project?.name ?? null },
            localApiBase: request.localApiBase ?? null,
            // The notice sink. Without it `chatHookService` builds every
            // `{type:'notice', code:'hook_failed'}` frame and drops it on the floor, so a
            // crashing hook was completely invisible to the user. Raw `emit` (not
            // `safeEmit`): the service already swallows sink failures itself, and a
            // hook notice is non-terminal, so it must not be able to abort the run.
            emit,
            // A GETTER, deliberately. This session is constructed BEFORE the lineage
            // transaction that mints `lineageId` (UserPromptSubmit has to run before the
            // user row is written), so a by-value field would freeze `null` for the whole
            // run and every later notice would be unattributable. `chatHookService` reads
            // `config.lineageId` at emit time, so the getter resolves to whatever the run
            // knows by then — null for pre-lineage notices, the real id afterwards.
            get lineageId() {
              return trackedLineageId
            },
          })
        : null

    // UserPromptSubmit runs BEFORE the user message is persisted so a prompt rewrite
    // flows into BOTH the persisted user row and the inference content (both derive
    // from request.content in BranchOrchestrator). Only for operations that create a
    // user message (send/branch/edit-branch) — repeat has no new user message, matching
    // the renderer. A blocked hook throws -> the outer catch finishes the run 'error'.
    if (
      hookSession &&
      (request.operation === 'send' || request.operation === 'branch' || request.operation === 'edit-branch')
    ) {
      phase = 'hook'
      request.content = await hookSession.runUserPromptSubmit(request.content, request.parentId ?? null)
      phase = 'lifecycle'
    }

    const { resolved, activeLineage, pendingOperationId } = this.messageRepo.transaction(() => {
    const sourceMessageId =
      request.operation === 'send'
        ? request.parentId ?? null
        : request.messageId ?? request.parentId ?? null
    let sourceLineage: LineageRow | null
    if (request.lineageId) {
      sourceLineage = this.lineageRepo.get(request.lineageId)
      if (!sourceLineage) throw new Error(`Lineage not found: ${request.lineageId}`)
    } else {
      sourceLineage = this.lineageRepo.resolve({ messageId: sourceMessageId })
    }
    if (!sourceLineage && sourceMessageId) {
      // Adopt legacy source content before deciding whether the requested write is
      // an exact-head continuation or a fork.
      sourceLineage = this.lineageRepo.reconcile({
        conversationId: request.conversationId,
        messageId: sourceMessageId,
      })
    }
    if (sourceLineage && sourceLineage.conversation_id !== request.conversationId) {
      throw new Error('Lineage belongs to a different conversation')
    }
    if (sourceLineage && sourceMessageId) {
      const sourceDetail = this.lineageRepo.getDetail(request.conversationId, sourceLineage.id)
      const sourcePath = sourceDetail?.pathMessageIds ?? []
      const sourceMessage = this.statements.getMessageById.get(sourceMessageId) as any
      const diagnostics = {
        operation: request.operation,
        conversationId: request.conversationId,
        streamId: request.streamId ?? null,
        operationId: request.operationId ?? null,
        requestedLineageId: request.lineageId ?? null,
        resolvedSourceLineageId: sourceLineage.id,
        sourceMessageId: String(sourceMessageId),
        sourceMessageParentId: sourceMessage?.parent_id ?? null,
        sourceMessageStoredLineageId: sourceMessage?.lineage_id ?? null,
        lineageParentId: sourceLineage.parent_lineage_id,
        lineageForkedFromMessageId: sourceLineage.forked_from_message_id,
        lineageRootMessageId: sourceLineage.root_message_id,
        lineageHeadMessageId: sourceLineage.head_message_id,
        lineagePathMessageIds: sourcePath.map(String),
        sourceInLineagePath: sourcePath.includes(String(sourceMessageId)),
      }
      if (request.operation !== 'send') {
        console.info('[LineageForkDebug][Main] validate', diagnostics)
      }
      if (!diagnostics.sourceInLineagePath) {
        if (shouldRejectSourceLineageMismatch(request.lineageId, diagnostics.sourceInLineagePath)) {
          // An explicit lineage is an exact client assertion, so a path mismatch is
          // genuinely invalid. Without one, resolve() only returns the message row's
          // creation owner. That lineage's moving head may now follow a sibling arm,
          // so creation ownership is not proof of current path membership.
          console.error('[LineageForkDebug][Main] membership-mismatch', diagnostics)
          throw new Error('Source message does not belong to the requested lineage')
        }
        console.warn('[LineageForkDebug][Main] inferred-owner-path-mismatch-allowed', diagnostics)
      }
    }
    if (request.operationId && request.operation !== 'send') {
      const existingOperation = this.lineageRepo.getForkOperation(request.operationId)
      if (existingOperation) {
        throw new Error(`Lineage operation already exists: ${request.operationId}`)
      }
    }

    const resolved = this.resolveExecution(request)
    const mustFork = request.operation !== 'send' || Boolean(sourceLineage && sourceLineage.head_message_id !== sourceMessageId)
    let activeLineage: LineageRow
    let pendingOperationId: string | null = null

    if (!sourceLineage && !sourceMessageId && resolved.userMessage) {
      activeLineage = this.lineageRepo.createRoot({
        id: request.lineageId ?? undefined,
        conversationId: request.conversationId,
        rootMessageId: resolved.userMessage.id,
      })
    } else if (mustFork) {
      const pending = this.lineageRepo.createPendingFork({
        operationId: request.operationId ?? undefined,
        conversationId: request.conversationId,
        sourceLineageId: sourceLineage?.id ?? null,
        sourceMessageId,
        operation: request.operation,
      })
      activeLineage = pending.lineage
      pendingOperationId = pending.operation.id
      // Branch/edit create user content immediately; repeat remains pending until
      // the first assistant turn is persisted by the lineage-aware sink.
      if (resolved.userMessage) {
        activeLineage = this.lineageRepo.materialize(pending.operation.id, resolved.userMessage.id).lineage
        pendingOperationId = null
      }
    } else if (sourceLineage) {
      activeLineage = resolved.userMessage
        ? this.lineageRepo.appendMessage(sourceLineage.id, resolved.userMessage.id)
        : sourceLineage
    } else {
      // A repeat against legacy/rootless content can only arrive with a source id,
      // so this fallback is for defensive compatibility with unusual callers.
      activeLineage = this.lineageRepo.createRoot({ conversationId: request.conversationId })
      pendingOperationId = request.operation === 'repeat'
        ? this.lineageRepo.createPendingFork({
            operationId: request.operationId ?? undefined,
            conversationId: request.conversationId,
            sourceLineageId: activeLineage.id,
            sourceMessageId,
            operation: request.operation,
          }).operation.id
        : null
    }
    return { resolved, activeLineage, pendingOperationId }
    })
    const lineageId = activeLineage.id
    trackedLineageId = lineageId
    assistantParentId = resolved.assistantParentId

    // The EARLIEST point `started` can correctly be emitted. It is now above the
    // streaming-run upsert, the decision-broker seed and the hook re-point, so a
    // failure in any of those still reaches a client that has a run to attach to.
    // It cannot move above the three steps that precede it, because they PRODUCE its
    // fields: the conversation lookup (does the conversation exist at all), the
    // UserPromptSubmit hook (which must run before the user row is written, since a
    // rewrite has to reach it), and the lineage transaction (which mints `lineageId`
    // and persists the user message that IS `parentId`). The outer catch emits a
    // synthetic `started` for failures before this line, so no terminal frame is ever
    // orphaned.
    emit({
      type: 'started',
      operation: request.operation,
      conversationId: request.conversationId,
      parentId: resolved.assistantParentId,
      provider: request.provider,
      modelName: request.modelName,
      streamId: trackedStreamId,
      lineageId,
    })
    startedEmitted = true

    // Phase 4: the cloud (openrouter) route relays free-tier events and adopts Railway
    // message ids, but ONLY when gateway.chat is on. Every other provider/flag-off run
    // stays on TreeMessageSink with drop-frame parity. Resolved here (not at the loop)
    // so the sink exists for the outer catch's D1 error row even if the run dies before
    // the loop starts.
    const isCloudRoute = this.cloudChatEnabled && normalizeProviderRoute(request.provider) === 'openrouter'
    const sinkDeps = {
      messageRepo: this.messageRepo,
      lineageRepo: this.lineageRepo,
      lineageId,
      pendingOperationId,
    }
    // ONE sink instance for the run: the loop's turns and any terminal error row share
    // its pending-fork state, so whichever writes first materializes the fork.
    const sink: MessageSink = isCloudRoute ? new CloudMirrorSink(sinkDeps) : new TreeMessageSink(sinkDeps)
    runSink = sink

    trackedStreamId = this.streamingRunRepo.upsert({
      streamId: trackedStreamId,
      lineageId,
      conversationId: request.conversationId,
      parentMessageId: resolved.assistantParentId,
      streamType: request.operation === 'branch' || request.operation === 'edit-branch' ? 'branch' : 'primary',
      provider: request.provider,
      modelName: request.modelName,
      operation: request.operation,
      source: 'headless',
      rootMessageId: resolved.assistantParentId,
    })

    // Seed the pause/resume session on the FINAL (post-upsert) stream id. Default to
    // auto-approve; pause only when the caller EXPLICITLY sent toolAutoApprove:false
    // (the mobile LAN UI never sends it, so it always auto-approves).
    if (this.decisionBroker && trackedStreamId) {
      this.decisionBroker.initSession(trackedStreamId, { autoApproveAll: request.toolAutoApprove !== false })
    }

    // Re-point the hook session at the FINAL (post-upsert) stream id so hook payloads
    // (and any /resume-style correlation) use the same id the SSE clients see.
    if (hookSession && trackedStreamId) hookSession.streamId = trackedStreamId

    if (resolved.userMessage) {
      emit({ type: 'user_message_persisted', message: resolved.userMessage, lineageId })
    }

    emit({
      type: 'provider_routed',
      provider: request.provider,
      modelName: request.modelName,
    })

    // Keep the full parent chain in SQLite for branch navigation/auditability, but never
    // replay ancestors that a compaction summary has replaced. This restores the legacy
    // renderer-loop invariant for every server-owned operation (send/branch/edit/repeat).
    // `excludeContextExcludedMessages` enforces ErrorBlock.excludeFromContext: a
    // persisted failure stays in the tree (and on screen) but is NEVER replayed to the
    // model as its own prior words. This is the only server-side history assembly —
    // `listPathToMessage` has no other consumer — and the loop's compaction reuses this
    // same array, so the summary path is covered too.
    const history = trimHistoryToLatestCompaction(
      excludeContextExcludedMessages(
        this.conversationRepo.listPathToMessage(request.conversationId, resolved.historyLeafId)
      )
    )

    const resolvedOperationMode = request.operationMode ?? 'execute'
    // An explicit tools array (even empty) is authoritative — only fall back to the
    // default tool set when the caller omits `tools` entirely. This lets a client
    // that disabled every tool send [] and get NO tools, rather than the defaults.
    const resolvedTools = filterToolsForOperationMode(
      Array.isArray(request.tools) ? request.tools : this.defaultToolsProvider(),
      resolvedOperationMode
    )

    const buildSystemPromptForMode = (operationMode: 'plan' | 'execute') =>
      buildHeadlessSystemPrompt({
        operationMode,
        includeOperationModePrompt: request.includeOperationModePrompt ?? true,
        requestPrompt: request.systemPrompt ?? null,
        projectPrompt: project?.system_prompt ?? null,
        conversationPrompt: conversation?.system_prompt ?? null,
        planModeVerbosity: request.planModeVerbosity ?? 'concise',
      })
    const systemPrompt = buildSystemPromptForMode(resolvedOperationMode)
    const agentSystemPrompt = buildSystemPromptForMode('execute')
    // `trackedStreamId` is a `let` (reassigned at the streamingRunRepo.upsert above), so
    // TypeScript cannot carry the truthiness narrowing into the async closure below.
    // Capture the (now stable) value in a const so the narrowing survives.
    const decisionStreamId = trackedStreamId
    const requestOperationModeUpgrade =
      this.decisionBroker && decisionStreamId
        ? async (toolCall: { id: string; name: string; arguments: unknown }) => {
            const toolInput = parseToolArgs(toolCall.arguments)
            emit({
              type: 'operation_mode_upgrade_required',
              streamId: decisionStreamId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              toolInput,
            })
            const decision = await this.decisionBroker!.requestDecision({
              streamId: decisionStreamId,
              toolCallId: toolCall.id,
              signal,
            })
            return decision === 'switch_to_execute'
          }
        : undefined
    const conversationContext = request.conversationContext ?? conversation?.conversation_context ?? null
    const projectContext = request.projectContext ?? project?.context ?? null

    // Build a per-run loop with a run-scoped pausing executor when the broker is
    // wired; otherwise fall back to the ctor-built loop (preserves non-broker callers
    // and tests). Guarded on BOTH so a partially-wired ctor can't build a loop with an
    // undefined executor. The sink was built above (shared with the terminal error row).
    const loop = new ToolLoopService({
      sink,
      providerRouter: this.providerRouter,
      executeTool:
        this.decisionBroker && this.toolExecutor
          ? this.makePausingExecutor(trackedStreamId, emit, signal, hookSession ?? undefined)
          : this.toolExecutor,
      toolInvocationRepo: new ToolInvocationRepo({ statements: this.statements }),
      compactBranch: this.compactBranch,
    })
    const emitWithLineage = (event: HeadlessStreamEvent) => {
      if (event.type === 'assistant_message_persisted') {
        // Remember the loop's newest assistant row: it is the D1 "partial" a terminal
        // error row must hang off (and must never overwrite).
        const persistedId = (event as { message?: { id?: unknown } }).message?.id
        if (typeof persistedId === 'string') lastPersistedAssistantId = persistedId
      }
      if (
        event.type === 'assistant_message_persisted' ||
        event.type === 'complete' ||
        event.type === 'error'
      ) {
        emit({ ...event, lineageId } as HeadlessStreamEvent)
      } else {
        emit(event)
      }
    }

    let toolLoopResult: ToolLoopRunResult
    phase = 'provider'
    try {
      toolLoopResult = await loop.run(
      {
        provider: request.provider,
        operation: request.operation,
        modelName: request.modelName,
        conversationId: request.conversationId,
        lineageId,
        assistantParentId: resolved.assistantParentId,
        history,
        userContent: resolved.userContentForInference,
        systemPrompt,
        conversationContext,
        projectContext,
        think: request.think,
        temperature: request.temperature,
        userId: request.userId ?? null,
        accessToken: request.accessToken ?? null,
        accountId: request.accountId ?? null,
        attachmentsBase64: request.attachmentsBase64 ?? null,
        retrigger: request.retrigger,
        executionMode: request.executionMode ?? 'client',
        isBranch: request.isBranch ?? (request.operation === 'branch' || request.operation === 'edit-branch'),
        isElectron: request.isElectron ?? true,
        imageConfig: request.imageConfig,
        reasoningConfig: request.reasoningConfig,
        serviceTier: request.serviceTier,
        promptCacheRetention: request.promptCacheRetention,
        tools: resolvedTools,
        streamId: trackedStreamId,
        rootPath: request.rootPath ?? conversation?.cwd ?? null,
        operationMode: resolvedOperationMode,
        agentSystemPrompt,
        requestOperationModeUpgrade,
        toolTimeoutMs: request.toolTimeoutMs,
        toolAutoApprove: request.toolAutoApprove,
        /**
         * Retry a TRANSIENT provider failure before giving up.
         *
         * Subagents have opted into this since they were written; the main chat loop never
         * did, so `maxProviderRetries` resolved to 0 and the retry branch was dead code for
         * the conversation the user is actually looking at. One dropped packet — switching
         * Wi-Fi, waking from sleep, a VPN flap — killed a half-written reply permanently.
         * Resumable runs did not help: they recover a dropped CLIENT socket, and the client
         * talks to 127.0.0.1, which a Wi-Fi change does not disturb. The break is on the
         * server's outbound leg, so there was no detached run left to reattach to.
         *
         * Only `retryProviderError` is enabled. `retryEmptyTurn` and
         * `finalizeOnSilentToolEnd` change what a turn MEANS, not how failures are handled,
         * so they stay off. `isTransientProviderError` gates this to connectivity/5xx/429 —
         * a 400 or a content filter still fails immediately — and each attempt emits a
         * `notice` so the backoff is visible instead of looking like a stall.
         */
        robustness: { retryProviderError: true },
        subagentReasoningEffort: request.subagentReasoningEffort,
        autoCompactionEnabled: request.autoCompactionEnabled,
        contextLength: request.contextLength,
        compactionThresholdPercent: request.compactionThresholdPercent,
        compactionProvider: request.compactionProvider,
        compactionModelName: request.compactionModelName,
        compactionSystemPrompt: request.compactionSystemPrompt,
        signal,
        // Phase 3: drives the per-turn hook-context fold + the Stop hook. Undefined
        // when hooks are off (subagents/tests/mobile) => loop behavior unchanged.
        hooks: hookSession?.toolLoopHooks(),
        // Phase 4: relay Railway free-tier frames only on the cloud (openrouter) route
        // under gateway.chat. False everywhere else => drop-frame parity.
        relayFreeTierEvents: isCloudRoute,
      },
        emitWithLineage
      )
    } catch (error) {
      if (error instanceof ProviderErrorAssistantResponse) {
        // The classified failure is persisted as its own assistant row so it survives a
        // reload and carries the one call to action.
        //
        // R1(c)/R3 parenting: `error.assistantMessage` is whatever the LOOP wrote for
        // this turn before it threw — the D1 partial. It is read defensively (`?.`)
        // because the loop no longer always writes one: once the provider-prose persist
        // is gone, the ONLY row explaining this failure is the one written here, which
        // is exactly the "one row carries the explanation" rule. When the loop DID
        // persist something, this row hangs off it rather than replacing it, so the
        // words the user already saw are kept.
        const envelope = this.classifyRunError(error, {
          provider: request.provider,
          modelName: request.modelName,
          phase: 'provider',
        })
        const loopMessage = error.assistantMessage ?? null
        const errorRow = this.persistErrorAssistantMessage({
          sink,
          conversationId: request.conversationId,
          parentId: loopMessage?.id ?? lastPersistedAssistantId ?? resolved.assistantParentId,
          modelName: request.modelName,
          envelope,
          lineageId,
          emit: safeEmit,
        })
        this.streamingRunRepo.finish(trackedStreamId, {
          status: 'error',
          endReason: 'error',
          assistantMessageId: loopMessage?.id ?? null,
          finalMessageId: errorRow?.id ?? loopMessage?.id ?? null,
          error: error.providerError.originalMessage,
          metadata: {
            provider: error.providerError.provider,
            retryExhausted: error.providerError.retryExhausted,
            status: error.providerError.status,
            errorType: error.providerError.errorType,
            resetAt: error.providerError.resetAt,
            errorCode: envelope.code,
            recoverability: envelope.recoverability,
          },
        })
        // Still ONE terminal frame for this path — `complete` is terminal to the run
        // session, so an additional `error` frame would be a second one.
        //
        // `message` MUST be the error row, not its parent. `complete` is the only frame
        // that rebuilds the rendered path: sseProjection turns it into
        // `streamCompleted({messageId, updatePath:true})`, and the reducer truncates
        // `currentPath` to END at that message. Naming the parent here wrote the error
        // row to SQLite and then immediately cut it off the path, so the explanation
        // existed but was never drawn (`['u1','p1','e1'] -> ['u1','p1']`). Falling back
        // to the loop's row only when persistence itself failed keeps the old behaviour
        // for the one case where there is no error row to point at.
        const terminalMessage = errorRow ?? loopMessage
        // R2 — ONE BUBBLE PER FAILURE. `envelope` on a `complete` frame is what makes
        // sseProjection record a tier-2 `ChatErrorRecord`. When the ErrorBlock row above
        // exists, that record is a SECOND surface for the same failure, so the envelope
        // is withheld: the row already carries it (both as `content` and inside the
        // block). It is still sent when nothing was persisted, so the failure always has
        // exactly one surface. CROSS-FILE: once `complete` gains
        // `persistedErrorMessageId` (as the `error` member has), send the envelope
        // unconditionally and let the renderer discriminate on that instead.
        safeEmit(
          errorRow
            ? { type: 'complete', message: terminalMessage, providerError: true, lineageId }
            : { type: 'complete', message: terminalMessage, providerError: true, envelope, lineageId }
        )
        return
      }
      throw error
    }

    this.streamingRunRepo.finish(trackedStreamId, {
      status: 'completed',
      endReason: 'completed',
      assistantMessageId: toolLoopResult.finalAssistantMessage?.id ?? null,
      finalMessageId: toolLoopResult.finalAssistantMessage?.id ?? null,
    })

    emit({ type: 'complete', message: toolLoopResult.finalAssistantMessage, lineageId })
    } catch (error) {
      // ── The ONE terminal-frame authority. Everything below classifies once, persists
      // once (D1), and emits exactly one terminal frame. `chatRoutes` publishes its own
      // frame ONLY for errors that never reached this catch. ──
      const errorMessage = error instanceof Error ? error.message : String(error)
      const lineageId = trackedLineageId ?? this.streamingRunRepo.getLineageId(trackedStreamId)

      // No terminal frame may arrive at a client that never saw a `started`: it would
      // have no run to attach the bubble to. Failures before the lineage transaction
      // (conversation missing, a blocking UserPromptSubmit hook, a lineage conflict)
      // get a synthetic one here, with the best parent known at that point.
      const ensureStarted = () => {
        if (startedEmitted) return
        startedEmitted = true
        safeEmit({
          type: 'started',
          operation: request.operation,
          conversationId: request.conversationId,
          parentId: assistantParentId ?? request.parentId ?? null,
          provider: request.provider,
          modelName: request.modelName,
          streamId: trackedStreamId,
          lineageId,
        })
      }

      // R3 — A USER CANCEL IS NOT A FAILURE.
      //
      // Client disconnect / explicit cancel. Previously this recorded 'aborted' and
      // returned WITHOUT emitting anything, so `runSessionRegistry` (which only treats
      // complete/error as terminal) never marked the session terminal and a reconnecting
      // client waited forever. The frame below therefore still goes out — it is a
      // LIFECYCLE signal ("this run has ended, stop waiting"), riding the `error` member
      // only because that is the wire's terminal shape.
      //
      // Two things make that unmistakable to a reader, and both are load-bearing:
      //   * `envelope.code` is `cancelled` (or `run_expired` for a reaper eviction) —
      //     the code a consumer keys off to skip recording a durable red bubble.
      //   * `persistedErrorMessageId` is ABSENT, and no ErrorBlock row is written. A
      //     deliberate Stop must not leave a permanent error in the tree, so there is
      //     nothing to point at; absence here means "the server persisted nothing",
      //     which for a cancel is the whole point rather than a fallback.
      // Nothing else in this branch may start persisting on the cancel path without
      // breaking that contract.
      if (signal?.aborted || isAbortError(error)) {
        this.streamingRunRepo.finish(trackedStreamId, {
          status: 'aborted',
          endReason: 'aborted',
          error: 'Run aborted',
        })
        ensureStarted()
        safeEmit({
          type: 'error',
          error: 'Run aborted',
          envelope: buildCancellationEnvelope(signal),
          terminal: true,
          lineageId,
        })
        return
      }

      // D2: an expired Yggdrasil session is `session_expired` with a "Sign in" action,
      // and nothing else — no forced navigation, no modal. D3 (free-tier exhaustion)
      // needs no special case at all: the provider attaches `free_tier_exhausted`, the
      // classifier honours it, and it flows down this same path into a bubble.
      const requiresReauthentication = error instanceof RailwayAppAuthError
      let envelope = this.classifyRunError(error, {
        provider: request.provider,
        modelName: request.modelName,
        phase,
      })
      if (requiresReauthentication && envelope.code !== 'session_expired') {
        envelope = buildChatErrorEnvelope('session_expired', {
          detail: envelope.detail ?? errorMessage,
          provider: envelope.provider ?? request.provider,
          status: envelope.status ?? 401,
          action: { kind: 'sign_in', label: 'Sign in' },
        })
      }

      ensureStarted()

      // D1 / R1(c): keep whatever the loop persisted (never overwritten, never
      // discarded) and add the failure as its own assistant row, parented onto that
      // partial so `user -> partial -> error` is the tree shape and the user keeps the
      // words AND gets the explanation. Only possible once the user message and the
      // lineage exist — before that there is nothing to parent it to, and `runSink` is
      // still null, so `errorRow` stays null and the frame below advertises nothing.
      const errorRow = this.persistErrorAssistantMessage({
        sink: runSink,
        conversationId: request.conversationId,
        parentId: lastPersistedAssistantId ?? assistantParentId,
        modelName: request.modelName,
        envelope,
        lineageId,
        emit: safeEmit,
      })

      this.streamingRunRepo.finish(trackedStreamId, {
        status: 'error',
        endReason: 'error',
        assistantMessageId: lastPersistedAssistantId ?? errorRow?.id ?? null,
        finalMessageId: errorRow?.id ?? lastPersistedAssistantId ?? null,
        error: errorMessage,
        metadata: {
          errorCode: envelope.code,
          recoverability: envelope.recoverability,
          provider: envelope.provider ?? null,
          status: envelope.status ?? null,
        },
      })
      safeAssign(error, 'lineageId', lineageId)
      if (requiresReauthentication) {
        // Non-terminal by itself; it exists so a client can react to the auth state.
        // `envelope` is what it shows — `message` stays raw for logs/back-compat.
        safeEmit({ type: 'reauth_required', message: errorMessage, envelope })
      }
      // R2 — ONE BUBBLE PER FAILURE. `persistedErrorMessageId` is the tier-1/tier-2
      // discriminator: PRESENT means this failure is already durable message content
      // (the row above), so the renderer must NOT also create a `ChatErrorRecord`;
      // ABSENT means the server had nothing to attach it to and the renderer owns the
      // only surface. It is spread in rather than set to `null` so "the server persisted
      // nothing" is a missing key, never an ambiguous null.
      safeEmit({
        type: 'error',
        error: errorMessage,
        envelope,
        terminal: true,
        lineageId,
        ...(errorRow?.id ? { persistedErrorMessageId: errorRow.id as string } : {}),
      })

      // Rethrow so callers still log/propagate, but stamped so the route does not
      // publish a SECOND terminal frame over this one (the renderer keeps the last).
      if (error && typeof error === 'object') {
        throw markChatErrorPublished(error, envelope)
      }
      throw markChatErrorPublished(new Error(errorMessage), envelope)
    } finally {
      // Drain any pending decisions + the per-stream session so a disconnected or
      // errored run never leaks a paused promise. rejectAllForStream also clears the session.
      if (this.decisionBroker && trackedStreamId) this.decisionBroker.rejectAllForStream(trackedStreamId)
    }
  }
}
