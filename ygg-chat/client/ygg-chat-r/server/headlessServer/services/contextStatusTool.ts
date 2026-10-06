import type { ToolExecutor } from './toolLoopService.js'

export interface BranchContextStatus {
  conversationId: string
  lineageId: string | null
  streamId: string | null
  messageId: string
  provider: string
  modelName: string
  usedTokens: number
  totalContextLimit: number
  remainingTokens: number
  usedPercent: number
  remainingPercent: number
  source: 'reported' | 'estimated'
  recordedAt: string
}

/** Keep live run state in-process, before ordinary background job dispatch. */
export function createContextStatusExecutor(leafExecutor: ToolExecutor): ToolExecutor {
  return async (toolCall, context) => {
    if (toolCall.name !== 'context_status') return leafExecutor(toolCall, context)
    context.signal?.throwIfAborted()
    if (!context.getContextStatus) {
      throw new Error('Context status is only available inside an active model/tool run.')
    }
    const status = context.getContextStatus()
    return {
      remainingTokens: status.remainingTokens,
      remainingPercent: Math.round(status.remainingPercent),
      note: 'Approximate snapshot; not guaranteed output capacity.',
    }
  }
}
