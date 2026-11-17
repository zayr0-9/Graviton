import type { ConversationId } from '../../../../../shared/types'

/**
 * Key for a pending live mode switch. Each run has its own server mode control, so two
 * forks of one conversation (for example two agents-pill cards) can switch independently.
 */
export const operationModeChangeKey = (conversationId: ConversationId | string, streamId?: string | null): string =>
  streamId ? `${String(conversationId)}::${streamId}` : String(conversationId)
