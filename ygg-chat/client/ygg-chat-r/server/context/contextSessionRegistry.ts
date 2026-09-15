// server/context/contextSessionRegistry.ts
// Per-conversation handle to the active ConversationContextLoader so tool handlers
// that only receive `conversationId` (skill_manager) and the subagent executor can
// reach project skills, agents, and the directory settings of the running chat.

import type { ConversationContextLoader } from './contextLoader.js'

const loaders = new Map<string, ConversationContextLoader>()

export function registerConversationContext(conversationId: string, loader: ConversationContextLoader): void {
  loaders.set(conversationId, loader)
}

export function getConversationContext(conversationId: string | null | undefined): ConversationContextLoader | null {
  if (!conversationId) return null
  return loaders.get(conversationId) ?? null
}

export function unregisterConversationContext(conversationId: string, loader?: ConversationContextLoader): void {
  if (loader && loaders.get(conversationId) !== loader) return
  loaders.delete(conversationId)
}
