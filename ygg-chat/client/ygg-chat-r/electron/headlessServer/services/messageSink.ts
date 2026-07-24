import type { OpenAIContextUsage } from '../../../../../shared/contextUsage.js'
import type { MessageRepo } from '../persistence/messageRepo.js'
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

  constructor(deps: { messageRepo: MessageRepo }) {
    this.messageRepo = deps.messageRepo
  }

  persistAssistantMessage(draft: AssistantMessageDraft): any {
    return this.messageRepo.createMessage({
      conversationId: draft.conversationId,
      parentId: draft.parentId,
      role: 'assistant',
      content: draft.content ?? '',
      modelName: draft.modelName,
      toolCalls: draft.toolCalls ?? undefined,
      contentBlocks: draft.contentBlocks ?? undefined,
      contextUsage: draft.contextUsage ?? undefined,
    })
  }

  updateAssistantToolState(
    messageId: string,
    update: { contentBlocks?: any[] | null; toolCalls?: any[] | null }
  ): any | null {
    return this.messageRepo.updateAssistantToolState(messageId, update)
  }
}
