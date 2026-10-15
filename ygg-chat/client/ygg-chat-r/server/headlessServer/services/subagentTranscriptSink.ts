import type { MessageSink, AssistantMessageDraft } from './messageSink.js'
import type { SubagentRunRepo } from '../persistence/subagentRunRepo.js'

/**
 * MessageSink that writes a subagent's assistant turns into the dedicated
 * subagent_messages transcript (never the main conversation tree). The returned
 * objects carry the fields the tool loop relies on in memory — id, role,
 * content, content_blocks, tool_calls, parent_id — so parent chaining and the
 * compaction summary validation (parent_id === assistantMessage.id) still hold.
 */
export class SubagentTranscriptSink implements MessageSink {
  private readonly runRepo: SubagentRunRepo
  private readonly runId: string

  constructor(deps: { runRepo: SubagentRunRepo; runId: string }) {
    this.runRepo = deps.runRepo
    this.runId = deps.runId
  }

  persistAssistantMessage(draft: AssistantMessageDraft): any {
    const contentBlocks = draft.contentBlocks ?? null
    const toolCalls = draft.toolCalls ?? null
    const row = this.runRepo.appendMessage(this.runId, {
      role: 'assistant',
      content: draft.content ?? '',
      thinkingBlock: draft.thinkingBlock ?? null,
      toolCalls,
      contentBlocks,
      meta: draft.meta,
    })

    return {
      ...row,
      // Parsed shapes the loop pushes into its in-memory history.
      content_blocks: contentBlocks,
      tool_calls: toolCalls,
      parent_id: draft.parentId ?? null,
      conversation_id: draft.conversationId,
      ...(draft.contextUsage ? { context_usage: draft.contextUsage } : {}),
    }
  }

  persistControlMessage(draft: { conversationId: string; parentId: string | null; content: string; meta: Record<string, unknown> }): any {
    const row = this.runRepo.appendMessage(this.runId, { role: 'user', content: draft.content, meta: draft.meta })
    return { ...row, parent_id: draft.parentId, conversation_id: draft.conversationId }
  }

  finaliseCompaction(messageId: string, update: { content: string; contentBlocks: any[]; meta: Record<string, unknown> }): any {
    return this.runRepo.finaliseCompaction(this.runId, messageId, update)
  }

  updateAssistantToolState(
    messageId: string,
    update: { contentBlocks?: any[] | null; toolCalls?: any[] | null }
  ): any | null {
    const row = this.runRepo.updateMessageToolState(this.runId, messageId, update)
    if (!row) return null
    return {
      ...row,
      content_blocks: update.contentBlocks ?? null,
      tool_calls: update.toolCalls ?? null,
    }
  }
}
