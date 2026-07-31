import type { HeadlessMessageRequest, HeadlessStreamEvent } from '../contracts/headlessApi.js'
import { ConversationRepo } from '../persistence/conversationRepo.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import { ProjectRepo } from '../persistence/projectRepo.js'
import { StreamingRunRepo } from '../persistence/streamingRunRepo.js'
import { TreeMessageSink } from './messageSink.js'
import type { ProviderTokenStore } from '../providers/tokenStore.js'
import { BranchOrchestrator, type ResolvedExecution } from './branchOrchestrator.js'
import { buildHeadlessSystemPrompt } from './headlessSystemPrompt.js'
import { ProviderRouter } from './providerRouter.js'
import {
  ProviderErrorAssistantResponse,
  ToolLoopService,
  type ToolExecutor,
  type ToolLoopCompactor,
  type ToolLoopRunResult,
} from './toolLoopService.js'
import type { DecisionBroker, ClarifyDecision, PermissionDecision } from './decisionBroker.js'
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
    const action = typeof args?.action === 'string' ? args.action : ''
    return action !== 'invoke' && CUSTOM_TOOL_MANAGER_BYPASS_ACTIONS.has(action)
  }
  return false
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

export interface HeadlessChatOrchestrator {
  runMessage(
    request: HeadlessMessageRequest,
    emit: (event: HeadlessStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<void>
}

export class ChatOrchestrator implements HeadlessChatOrchestrator {
  private readonly conversationRepo: ConversationRepo
  private readonly messageRepo: MessageRepo
  private readonly projectRepo: ProjectRepo
  private readonly streamingRunRepo: StreamingRunRepo
  private readonly providerRouter: ProviderRouter
  private readonly branchOrchestrator: BranchOrchestrator
  private readonly toolLoopService: ToolLoopService
  private readonly defaultToolsProvider: NonNullable<ChatOrchestratorDeps['defaultToolsProvider']>
  // Kept as fields so runMessage can build a per-run ToolLoopService with a
  // run-scoped pausing executor (mirrors SubagentRunService.countingExecutor).
  private readonly toolExecutor?: ToolExecutor
  private readonly compactBranch?: ToolLoopCompactor
  private readonly decisionBroker?: DecisionBroker

  constructor(deps: ChatOrchestratorDeps) {
    this.conversationRepo = new ConversationRepo({ db: deps.db, statements: deps.statements })
    this.messageRepo = new MessageRepo({ db: deps.db, statements: deps.statements })
    this.projectRepo = new ProjectRepo({ db: deps.db })
    this.streamingRunRepo = new StreamingRunRepo({ statements: deps.statements })
    this.providerRouter = deps.providerRouter ?? new ProviderRouter({ tokenStore: deps.tokenStore })
    this.branchOrchestrator = deps.branchOrchestrator ?? new BranchOrchestrator()
    this.toolExecutor = deps.toolExecutor
    this.compactBranch = deps.compactBranch
    this.decisionBroker = deps.decisionBroker
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
    signal?: AbortSignal
  ): ToolExecutor {
    const base = this.toolExecutor!
    const broker = this.decisionBroker!
    return async (toolCall, context) => {
      const sig = context.signal ?? signal
      // Auto-approve (whole-run or after allow_always): no pause.
      if (broker.isAutoApproveAll(streamId)) return base(toolCall, context)

      const args = parseToolArgs(toolCall.arguments)

      // plan_md clarify is renderer-interactive and the base executor throws on it;
      // intercept, ask the client, and RETURN a normal (non-error) clarify result.
      if (toolCall.name === 'plan_md' && args?.action === 'clarify') {
        emit({
          type: 'clarify_required',
          streamId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          questions: Array.isArray(args.questions) ? args.questions : [],
        })
        const decision = await broker.requestDecision<ClarifyDecision>({ streamId, toolCallId: toolCall.id, signal: sig })
        return {
          clarified: !decision.cancelled,
          cancelled: decision.cancelled ?? false,
          questions: Array.isArray(args.questions) ? args.questions.length : 0,
          answers: decision.answers ?? [],
        }
      }

      // Read-only / management tools never prompt.
      if (shouldBypassPermission(toolCall.name, args)) return base(toolCall, context)

      // Interactive permission: pause, ask, resume.
      emit({
        type: 'permission_required',
        streamId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolInput: args,
      })
      const decision = await broker.requestDecision<PermissionDecision>({ streamId, toolCallId: toolCall.id, signal: sig })
      if (decision === 'deny') {
        // Throw -> the loop records an is_error tool_result and continues.
        throw new Error('Tool execution denied by user')
      }
      if (decision === 'allow_always') broker.setAutoApproveAll(streamId)
      return base(toolCall, context)
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

    const resolved = this.resolveExecution(request)

    trackedStreamId = this.streamingRunRepo.upsert({
      streamId: trackedStreamId,
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

    emit({
      type: 'started',
      operation: request.operation,
      conversationId: request.conversationId,
      parentId: resolved.assistantParentId,
      provider: request.provider,
      modelName: request.modelName,
      streamId: trackedStreamId,
    })

    if (resolved.userMessage) {
      emit({ type: 'user_message_persisted', message: resolved.userMessage })
    }

    emit({
      type: 'provider_routed',
      provider: request.provider,
      modelName: request.modelName,
    })

    const history = this.conversationRepo.listPathToMessage(request.conversationId, resolved.historyLeafId)

    const resolvedOperationMode = request.operationMode ?? 'execute'
    // An explicit tools array (even empty) is authoritative — only fall back to the
    // default tool set when the caller omits `tools` entirely. This lets a client
    // that disabled every tool send [] and get NO tools, rather than the defaults.
    const resolvedTools = filterToolsForOperationMode(
      Array.isArray(request.tools) ? request.tools : this.defaultToolsProvider(),
      resolvedOperationMode
    )

    const project = conversation?.project_id ? this.projectRepo.getById(conversation.project_id) : null
    const systemPrompt = buildHeadlessSystemPrompt({
      operationMode: resolvedOperationMode,
      includeOperationModePrompt: request.includeOperationModePrompt ?? true,
      requestPrompt: request.systemPrompt ?? null,
      projectPrompt: project?.system_prompt ?? null,
      conversationPrompt: conversation?.system_prompt ?? null,
      planModeVerbosity: request.planModeVerbosity ?? 'concise',
    })
    const conversationContext = request.conversationContext ?? conversation?.conversation_context ?? null
    const projectContext = request.projectContext ?? project?.context ?? null

    // Build a per-run loop with a run-scoped pausing executor when the broker is
    // wired; otherwise fall back to the ctor-built loop (preserves non-broker callers
    // and tests). Guarded on BOTH so a partially-wired ctor can't build a loop with an
    // undefined executor.
    const loop =
      this.decisionBroker && this.toolExecutor
        ? new ToolLoopService({
            sink: new TreeMessageSink({ messageRepo: this.messageRepo }),
            providerRouter: this.providerRouter,
            executeTool: this.makePausingExecutor(trackedStreamId, emit, signal),
            compactBranch: this.compactBranch,
          })
        : this.toolLoopService

    let toolLoopResult: ToolLoopRunResult
    try {
      toolLoopResult = await loop.run(
      {
        provider: request.provider,
        operation: request.operation,
        modelName: request.modelName,
        conversationId: request.conversationId,
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
        toolTimeoutMs: request.toolTimeoutMs,
        autoCompactionEnabled: request.autoCompactionEnabled,
        contextLength: request.contextLength,
        compactionThresholdPercent: request.compactionThresholdPercent,
        compactionProvider: request.compactionProvider,
        compactionModelName: request.compactionModelName,
        compactionSystemPrompt: request.compactionSystemPrompt,
        signal,
      },
        emit
      )
    } catch (error) {
      if (error instanceof ProviderErrorAssistantResponse) {
        this.streamingRunRepo.finish(trackedStreamId, {
          status: 'error',
          endReason: 'provider_error',
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
        emit({ type: 'complete', message: error.assistantMessage, providerError: true })
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

    emit({ type: 'complete', message: toolLoopResult.finalAssistantMessage })
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
      this.streamingRunRepo.finish(trackedStreamId, {
        status: 'error',
        endReason: errorMessage.includes('context compaction') ? 'context_compaction_failed' : 'error',
        error: errorMessage,
      })
      throw error
    } finally {
      // Drain any pending decisions + the per-stream session so a disconnected or
      // errored run never leaks a paused promise. rejectAllForStream also clears the session.
      if (this.decisionBroker && trackedStreamId) this.decisionBroker.rejectAllForStream(trackedStreamId)
    }
  }
}
