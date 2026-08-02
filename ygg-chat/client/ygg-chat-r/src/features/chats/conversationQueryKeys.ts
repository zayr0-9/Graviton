import type { ConversationId } from '../../../../../shared/types'

export const normalizeConversationId = (conversationId: ConversationId | string | number): string =>
  String(conversationId)

export const conversationQueryKeys = {
  all: ['conversations'] as const,
  messages: (conversationId: ConversationId | string | number) =>
    ['conversations', normalizeConversationId(conversationId), 'messages'] as const,
}
