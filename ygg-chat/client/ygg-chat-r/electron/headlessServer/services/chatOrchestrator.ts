import type { HeadlessMessageRequest, HeadlessStreamEvent } from '../../../../../shared/headlessApi.js'
import { ConversationRepo } from '../persistence/conversationRepo.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import { ProjectRepo } from '../persistence/projectRepo.js'
import { StreamingRunRepo } from '../persistence/streamingRunRepo.js'
import { LineageRepo, type LineageRow } from '../persistence/lineageRepo.js'
import { ToolInvocationRepo } from '../persistence/toolInvocationRepo.js'
import { TreeMessageSink, CloudMirrorSink } from './messageSink.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import { BranchOrchestrator, type ResolvedExecution } from './branchOrchestrator.js'
import { buildHeadlessSystemPrompt } from './headlessSystemPrompt.js'
import { ProviderRouter, normalizeProviderRoute } from './providerRouter.js'
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
    let trackedStreamId = request.streamId ?? null
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
      request.content = await hookSession.runUserPromptSubmit(request.content, request.parentId ?? null)
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
    const history = trimHistoryToLatestCompaction(
      this.conversationRepo.listPathToMessage(request.conversationId, resolved.historyLeafId)
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

    // Phase 4: the cloud (openrouter) route relays free-tier events and adopts Railway
    // message ids, but ONLY when gateway.chat is on. Every other provider/flag-off run
    // stays on TreeMessageSink with drop-frame parity.
    const isCloudRoute = this.cloudChatEnabled && normalizeProviderRoute(request.provider) === 'openrouter'

    // Build a per-run loop with a run-scoped pausing executor when the broker is
    // wired; otherwise fall back to the ctor-built loop (preserves non-broker callers
    // and tests). Guarded on BOTH so a partially-wired ctor can't build a loop with an
    // undefined executor.
    const sinkDeps = {
      messageRepo: this.messageRepo,
      lineageRepo: this.lineageRepo,
      lineageId,
      pendingOperationId,
    }
    const loop = new ToolLoopService({
      sink: isCloudRoute ? new CloudMirrorSink(sinkDeps) : new TreeMessageSink(sinkDeps),
      providerRouter: this.providerRouter,
      executeTool:
        this.decisionBroker && this.toolExecutor
          ? this.makePausingExecutor(trackedStreamId, emit, signal, hookSession ?? undefined)
          : this.toolExecutor,
      toolInvocationRepo: new ToolInvocationRepo({ statements: this.statements }),
      compactBranch: this.compactBranch,
    })
    const emitWithLineage = (event: HeadlessStreamEvent) => {
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
        this.streamingRunRepo.finish(trackedStreamId, {
          status: 'error',
          endReason: 'error',
          assistantMessageId: error.assistantMessage?.id ?? null,
          finalMessageId: error.assistantMessage?.id ?? null,
          error: error.providerError.originalMessage,
          metadata: {
            provider: error.providerError.provider,
            retryExhausted: error.providerError.retryExhausted,
            status: error.providerError.status,
            errorType: error.providerError.errorType,
            resetAt: error.providerError.resetAt,
          },
        })
        emit({ type: 'complete', message: error.assistantMessage, providerError: true, lineageId })
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
      // Client disconnect / explicit cancel: record a clean 'aborted' outcome and
      // return WITHOUT rethrowing, so runSseOrchestrator does not write a spurious
      // provider-style { type: 'error' } frame (mirrors SubagentRunService).
      if (signal?.aborted || isAbortError(error)) {
        this.streamingRunRepo.finish(trackedStreamId, {
          status: 'aborted',
          endReason: 'aborted',
          error: 'Run aborted',
        })
        return
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      const requiresReauthentication = error instanceof RailwayAppAuthError
      this.streamingRunRepo.finish(trackedStreamId, {
        status: 'error',
        endReason: 'error',
        error: errorMessage,
      })
      if (typeof error === 'object' && error !== null) {
        ;(error as any).lineageId = this.streamingRunRepo.getLineageId(trackedStreamId)
      }
      if (requiresReauthentication) {
        emit({ type: 'reauth_required', message: errorMessage })
      }
      throw error
    } finally {
      // Drain any pending decisions + the per-stream session so a disconnected or
      // errored run never leaks a paused promise. rejectAllForStream also clears the session.
      if (this.decisionBroker && trackedStreamId) this.decisionBroker.rejectAllForStream(trackedStreamId)
    }
  }
}
