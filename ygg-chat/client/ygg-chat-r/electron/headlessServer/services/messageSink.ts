import type { OpenAIContextUsage } from '../../../../../shared/contextUsage.js'
import type { MessageRepo } from '../persistence/messageRepo.js'
import type { LineageRepo } from '../persistence/lineageRepo.js'
import type { ProviderToolCall } from '../providers/openRouterProvider.js'

/**
 * Persistence port for the shared tool loop.
 *
 * The main headless chat writes assistant turns into the conversation message
 * tree (TreeMessageSink over MessageRepo). Subagents write into a dedicated
 * transcript instead (SubagentTranscriptSink). Both must return a message-row
 * shaped object the loop can push into its in-memory history: it needs at least
 * `id`, `role`, `content`, `content_blocks`, `tool_calls`, and `parent_id`.
 */
export interface AssistantMessageDraft {
  conversationId: string
  parentId: string | null
  content: string
  modelName?: string | null
  toolCalls?: ProviderToolCall[] | null
  contentBlocks?: any[] | null
  contextUsage?: OpenAIContextUsage | null
  /**
   * Reasoning text. TreeMessageSink intentionally ignores this to keep main-tree
   * rows byte-identical to today (reasoning lives in content_blocks there);
   * transcript sinks persist it so the subagent viewer can show it.
   */
  thinkingBlock?: string | null
  /**
   * Phase 4: the Railway-authoritative message id, when the provider surfaced one.
   * ONLY CloudMirrorSink adopts it (so the local row shares Railway's id); every
   * other sink ignores it, and it is null off the cloud path.
   */
  providerMessageId?: string | null
}

const runMessageTransaction = <T>(messageRepo: MessageRepo, operation: () => T): T => {
  const transaction = (messageRepo as MessageRepo & { transaction?: <R>(callback: () => R) => R }).transaction
  return typeof transaction === 'function' ? transaction.call(messageRepo, operation) : operation()
}

export interface MessageSink {
  persistAssistantMessage(draft: AssistantMessageDraft): any
  updateAssistantToolState(
    messageId: string,
    update: { contentBlocks?: any[] | null; toolCalls?: any[] | null }
  ): any | null
}

/**
 * Default sink: writes assistant turns into the conversation message tree via
 * MessageRepo. Behavior is byte-for-byte identical to the pre-refactor loop,
 * which called messageRepo.createMessage / updateAssistantToolState directly.
 */
export class TreeMessageSink implements MessageSink {
  private readonly messageRepo: MessageRepo
  private readonly lineageRepo?: LineageRepo
  private readonly lineageId?: string | null
  private pendingOperationId?: string | null

  constructor(deps: { messageRepo: MessageRepo; lineageRepo?: LineageRepo; lineageId?: string | null; pendingOperationId?: string | null }) {
    this.messageRepo = deps.messageRepo
    this.lineageRepo = deps.lineageRepo
    this.lineageId = deps.lineageId
    this.pendingOperationId = deps.pendingOperationId
  }

  persistAssistantMessage(draft: AssistantMessageDraft): any {
    return runMessageTransaction(this.messageRepo, () => {
      const message = this.messageRepo.createMessage({
        conversationId: draft.conversationId,
        parentId: draft.parentId,
        role: 'assistant',
        content: draft.content ?? '',
        modelName: draft.modelName,
        toolCalls: draft.toolCalls ?? undefined,
        contentBlocks: draft.contentBlocks ?? undefined,
        contextUsage: draft.contextUsage ?? undefined,
      })
      if (this.lineageRepo && this.lineageId) {
        if (this.pendingOperationId) {
          this.lineageRepo.materialize(this.pendingOperationId, message.id)
          this.pendingOperationId = null
        } else {
          this.lineageRepo.appendMessage(this.lineageId, message.id)
        }
      }
      return message
    })
  }

  updateAssistantToolState(
    messageId: string,
    update: { contentBlocks?: any[] | null; toolCalls?: any[] | null }
  ): any | null {
    return this.messageRepo.updateAssistantToolState(messageId, update)
  }
}

/**
 * Cloud sink: identical to TreeMessageSink except it adopts the Railway-authoritative
 * message id (draft.providerMessageId) so the local SQLite row shares Railway's id —
 * the server-side replacement for the renderer dualSyncManager's id adoption. When the
 * provider surfaced no id (streamed-only frame / native provider), providerMessageId is
 * null and MessageRepo mints a uuid, so the fallback matches TreeMessageSink exactly.
 * Selected in ChatOrchestrator only for the openrouter route under gateway.chat.
 */
export class CloudMirrorSink implements MessageSink {
  private readonly messageRepo: MessageRepo
  private readonly lineageRepo?: LineageRepo
  private readonly lineageId?: string | null
  private pendingOperationId?: string | null

  constructor(deps: { messageRepo: MessageRepo; lineageRepo?: LineageRepo; lineageId?: string | null; pendingOperationId?: string | null }) {
    this.messageRepo = deps.messageRepo
    this.lineageRepo = deps.lineageRepo
    this.lineageId = deps.lineageId
    this.pendingOperationId = deps.pendingOperationId
  }

  persistAssistantMessage(draft: AssistantMessageDraft): any {
    return runMessageTransaction(this.messageRepo, () => {
      const message = this.messageRepo.createMessage({
        id: draft.providerMessageId ?? undefined,
        conversationId: draft.conversationId,
        parentId: draft.parentId,
        role: 'assistant',
        content: draft.content ?? '',
        modelName: draft.modelName,
        toolCalls: draft.toolCalls ?? undefined,
        contentBlocks: draft.contentBlocks ?? undefined,
        contextUsage: draft.contextUsage ?? undefined,
      })
      if (this.lineageRepo && this.lineageId) {
        if (this.pendingOperationId) {
          this.lineageRepo.materialize(this.pendingOperationId, message.id)
          this.pendingOperationId = null
        } else {
          this.lineageRepo.appendMessage(this.lineageId, message.id)
        }
      }
      return message
    })
  }

  updateAssistantToolState(
    messageId: string,
    update: { contentBlocks?: any[] | null; toolCalls?: any[] | null }
  ): any | null {
    return this.messageRepo.updateAssistantToolState(messageId, update)
  }
}
