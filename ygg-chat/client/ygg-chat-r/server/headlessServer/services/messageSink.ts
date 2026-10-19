import { extractOpenAIContextUsageFromBlocks, openAIContextUsageBlock, type OpenAIContextUsage } from '../../../../../shared/contextUsage.js'
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
  meta?: Record<string, unknown>
  statisticsKind?: 'model_response' | 'terminal_error'
}

function durableResponseBlocks(draft: AssistantMessageDraft): any[] | undefined {
  if (!draft.contextUsage || extractOpenAIContextUsageFromBlocks(draft.contentBlocks)) return draft.contentBlocks ?? undefined
  const blocks = draft.contentBlocks?.length ? draft.contentBlocks : draft.content
    ? [{ type: 'text', content: draft.content, index: 0 }] : []
  return [...blocks, openAIContextUsageBlock(draft.contextUsage)]
}

const runMessageTransaction = <T>(messageRepo: MessageRepo, operation: () => T): T => {
  const transaction = (messageRepo as MessageRepo & { transaction?: <R>(callback: () => R) => R }).transaction
  // Function.prototype.call does not preserve the generic, so annotate the call site.
  return typeof transaction === 'function' ? transaction.call<unknown, [() => T], T>(messageRepo, operation) : operation()
}

export interface MessageSink {
  persistControlMessage?(draft: { conversationId: string; parentId: string | null; content: string; meta: Record<string, unknown> }): any
  finaliseCompaction?(messageId: string, update: { content: string; contentBlocks: any[]; meta: Record<string, unknown> }): any
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
  private readonly streamId?: string
  private readonly modelSelection?: { provider: string; model?: string | null }
  private readonly fastMode?: boolean
  private readonly onModelResponse?: (id: string) => void

  constructor(deps: { messageRepo: MessageRepo; lineageRepo?: LineageRepo; lineageId?: string | null; pendingOperationId?: string | null; streamId?: string; onModelResponse?: (id: string) => void; modelSelection?: { provider: string; model?: string | null }; fastMode?: boolean }) {
    this.messageRepo = deps.messageRepo
    this.lineageRepo = deps.lineageRepo
    this.lineageId = deps.lineageId
    this.pendingOperationId = deps.pendingOperationId
    this.streamId = deps.streamId
    this.modelSelection = deps.modelSelection
    this.fastMode = deps.fastMode
    this.onModelResponse = deps.onModelResponse
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
        contentBlocks: durableResponseBlocks(draft),
        contextUsage: draft.contextUsage ?? undefined,
        meta: { ...draft.meta, ...(typeof this.fastMode === 'boolean' ? { fastMode: this.fastMode } : {}), ...(this.modelSelection ? { modelSelection: this.modelSelection } : {}), ...(this.streamId ? {
          runStatistics: { version: 1, streamId: this.streamId, kind: draft.statisticsKind ?? 'model_response' },
        } : {}) },
      })
      if (this.lineageRepo && this.lineageId) {
        if (this.pendingOperationId) {
          this.lineageRepo.materialize(this.pendingOperationId, message.id)
          this.pendingOperationId = null
        } else {
          this.lineageRepo.appendMessage(this.lineageId, message.id)
        }
      }
      if (draft.statisticsKind !== 'terminal_error') this.onModelResponse?.(message.id)
      return message
    })
  }

  persistControlMessage(draft: { conversationId: string; parentId: string | null; content: string; meta: Record<string, unknown> }): any {
    return runMessageTransaction(this.messageRepo, () => {
      const row = this.messageRepo.createMessage({ ...draft, role: 'user' })
      if (this.lineageRepo && this.lineageId) {
        if (this.pendingOperationId) {
          this.lineageRepo.materialize(this.pendingOperationId, row.id)
          this.pendingOperationId = null
        } else this.lineageRepo.appendMessage(this.lineageId, row.id)
      }
      return row
    })
  }

  finaliseCompaction(messageId: string, update: { content: string; contentBlocks: any[]; meta: Record<string, unknown> }): any {
    return this.messageRepo.finaliseCompaction(messageId, update)
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
  private readonly streamId?: string
  private readonly modelSelection?: { provider: string; model?: string | null }
  private readonly fastMode?: boolean
  private readonly onModelResponse?: (id: string) => void

  constructor(deps: { messageRepo: MessageRepo; lineageRepo?: LineageRepo; lineageId?: string | null; pendingOperationId?: string | null; streamId?: string; onModelResponse?: (id: string) => void; modelSelection?: { provider: string; model?: string | null }; fastMode?: boolean }) {
    this.messageRepo = deps.messageRepo
    this.lineageRepo = deps.lineageRepo
    this.lineageId = deps.lineageId
    this.pendingOperationId = deps.pendingOperationId
    this.streamId = deps.streamId
    this.modelSelection = deps.modelSelection
    this.fastMode = deps.fastMode
    this.onModelResponse = deps.onModelResponse
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
        contentBlocks: durableResponseBlocks(draft),
        contextUsage: draft.contextUsage ?? undefined,
        meta: { ...draft.meta, ...(typeof this.fastMode === 'boolean' ? { fastMode: this.fastMode } : {}), ...(this.modelSelection ? { modelSelection: this.modelSelection } : {}), ...(this.streamId ? {
          runStatistics: { version: 1, streamId: this.streamId, kind: draft.statisticsKind ?? 'model_response' },
        } : {}) },
      })
      if (this.lineageRepo && this.lineageId) {
        if (this.pendingOperationId) {
          this.lineageRepo.materialize(this.pendingOperationId, message.id)
          this.pendingOperationId = null
        } else {
          this.lineageRepo.appendMessage(this.lineageId, message.id)
        }
      }
      if (draft.statisticsKind !== 'terminal_error') this.onModelResponse?.(message.id)
      return message
    })
  }

  persistControlMessage(draft: { conversationId: string; parentId: string | null; content: string; meta: Record<string, unknown> }): any {
    return runMessageTransaction(this.messageRepo, () => {
      const row = this.messageRepo.createMessage({ ...draft, role: 'user' })
      if (this.lineageRepo && this.lineageId) {
        if (this.pendingOperationId) {
          this.lineageRepo.materialize(this.pendingOperationId, row.id)
          this.pendingOperationId = null
        } else this.lineageRepo.appendMessage(this.lineageId, row.id)
      }
      return row
    })
  }

  finaliseCompaction(messageId: string, update: { content: string; contentBlocks: any[]; meta: Record<string, unknown> }): any {
    return this.messageRepo.finaliseCompaction(messageId, update)
  }

  updateAssistantToolState(
    messageId: string,
    update: { contentBlocks?: any[] | null; toolCalls?: any[] | null }
  ): any | null {
    return this.messageRepo.updateAssistantToolState(messageId, update)
  }
}
