import type { HeadlessMessageRequest, HeadlessStreamEvent } from '../contracts/headlessApi.js'
import { ConversationRepo } from '../persistence/conversationRepo.js'
import { MessageRepo } from '../persistence/messageRepo.js'
import { ProjectRepo } from '../persistence/projectRepo.js'
import { StreamingRunRepo } from '../persistence/streamingRunRepo.js'
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
}

export interface HeadlessChatOrchestrator {
  runMessage(request: HeadlessMessageRequest, emit: (event: HeadlessStreamEvent) => void): Promise<void>
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

  constructor(deps: ChatOrchestratorDeps) {
    this.conversationRepo = new ConversationRepo({ db: deps.db, statements: deps.statements })
    this.messageRepo = new MessageRepo({ db: deps.db, statements: deps.statements })
    this.projectRepo = new ProjectRepo({ db: deps.db })
    this.streamingRunRepo = new StreamingRunRepo({ statements: deps.statements })
    this.providerRouter = deps.providerRouter ?? new ProviderRouter({ tokenStore: deps.tokenStore })
    this.branchOrchestrator = deps.branchOrchestrator ?? new BranchOrchestrator()
    this.toolLoopService =
      deps.toolLoopService ??
      new ToolLoopService({
        messageRepo: this.messageRepo,
        providerRouter: this.providerRouter,
        executeTool: deps.toolExecutor,
        compactBranch: deps.compactBranch,
      })
    this.defaultToolsProvider = deps.defaultToolsProvider ?? (() => [])
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

  async runMessage(request: HeadlessMessageRequest, emit: (event: HeadlessStreamEvent) => void): Promise<void> {
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
    const resolvedTools = filterToolsForOperationMode(
      Array.isArray(request.tools) && request.tools.length > 0 ? request.tools : this.defaultToolsProvider(),
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

    let toolLoopResult: ToolLoopRunResult
    try {
      toolLoopResult = await this.toolLoopService.run(
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
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.streamingRunRepo.finish(trackedStreamId, {
        status: 'error',
        endReason: errorMessage.includes('context compaction') ? 'context_compaction_failed' : 'error',
        error: errorMessage,
      })
      throw error
    }
  }
}
