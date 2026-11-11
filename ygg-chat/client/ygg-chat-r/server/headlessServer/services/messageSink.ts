import { extractContextUsageFromBlocks, contextUsageBlock, type ContextUsage } from '../../../../../shared/contextUsage.js'
import type { MessageRepo } from '../persistence/messageRepo.js'
import type { LineageRepo } from '../persistence/lineageRepo.js'
import type { ProviderToolCall } from '../providers/providerTypes.js'

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
  contextUsage?: ContextUsage | null
  /**
   * Reasoning text. TreeMessageSink intentionally ignores this to keep main-tree
   * rows byte-identical to today (reasoning lives in content_blocks there);
   * transcript sinks persist it so the subagent viewer can show it.
   */
  thinkingBlock?: string | null
  meta?: Record<string, unknown>
  statisticsKind?: 'model_response' | 'terminal_error' | 'compaction_summary'
}

function durableResponseBlocks(draft: AssistantMessageDraft): any[] | undefined {
  if (!draft.contextUsage || extractContextUsageFromBlocks(draft.contentBlocks)) return draft.contentBlocks ?? undefined
  const blocks = draft.contentBlocks?.length ? draft.contentBlocks : draft.content
    ? [{ type: 'text', content: draft.content, index: 0 }] : []
  return [...blocks, contextUsageBlock(draft.contextUsage)]
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
  private readonly toolAutoApprove?: () => boolean
  private readonly onModelResponse?: (id: string) => void

  constructor(deps: { messageRepo: MessageRepo; lineageRepo?: LineageRepo; lineageId?: string | null; pendingOperationId?: string | null; streamId?: string; onModelResponse?: (id: string) => void; modelSelection?: { provider: string; model?: string | null }; fastMode?: boolean; toolAutoApprove?: () => boolean }) {
    this.messageRepo = deps.messageRepo
    this.lineageRepo = deps.lineageRepo
    this.lineageId = deps.lineageId
    this.pendingOperationId = deps.pendingOperationId
    this.streamId = deps.streamId
    this.modelSelection = deps.modelSelection
    this.fastMode = deps.fastMode
    this.toolAutoApprove = deps.toolAutoApprove
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
        meta: { ...draft.meta, ...(this.toolAutoApprove ? { toolAutoApprove: this.toolAutoApprove() } : {}), ...(typeof this.fastMode === 'boolean' ? { fastMode: this.fastMode } : {}), ...(this.modelSelection ? { modelSelection: this.modelSelection } : {}), ...(this.streamId ? {
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
      if (!draft.statisticsKind || draft.statisticsKind === 'model_response') this.onModelResponse?.(message.id)
      return { ...message, ...(this.messageRepo.get?.(message.id) ?? {}) }
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
      return this.messageRepo.get?.(row.id) ?? row
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
