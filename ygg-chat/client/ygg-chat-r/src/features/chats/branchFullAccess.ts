import { branchModelKey, branchSettingsTarget, lineageSettingsKey } from './branchModelSelection'
import { composerApprovalHandoff, composerProvider } from './branchToolApproval'
import { isClaudeProvider } from '../../../../../shared/claudeProvider'
import type { ChatState } from './chatTypes'

export interface FullAccessSubmission {
  fullAccess: boolean
  fullAccessNotificationId?: string
}

export const restrictedAccess: FullAccessSubmission = { fullAccess: false }

export function composerFullAccessTarget(chat: ChatState) {
  const target = branchSettingsTarget(chat)
  if (target.mismatch || target.key == null) return null
  const handoff = composerApprovalHandoff(chat)
  return handoff ? branchModelKey(chat.conversation.currentConversationId, `handoff:${handoff.id}`) : target.key
}

export function readFullAccessChoice(chat: ChatState, key: string | null): FullAccessSubmission {
  return (key == null ? undefined : chat.branchFullAccessChoices?.[key]) ?? restrictedAccess
}

export function resolveComposerFullAccess(chat: ChatState): FullAccessSubmission {
  if (chat.selection?.status === 'pending' || chat.selection?.status === 'error') return restrictedAccess
  const choice = chat.composition.editingBranch
    ? chat.composition.branchEditModes?.fullAccess ?? restrictedAccess
    : Object.keys(chat.branchFullAccessChoices ?? {}).length ? readFullAccessChoice(chat, composerFullAccessTarget(chat)) : restrictedAccess
  return choice.fullAccess && isClaudeProvider(composerProvider(chat)) ? restrictedAccess : choice
}

export function resolveRunFullAccess(chat: ChatState, conversationId: string, streamId: string): FullAccessSubmission {
  const stream = chat.streaming?.byId[streamId]
  const lineageId = String(stream?.conversationId) === conversationId && stream?.lineage.lineageIdConfirmed
    ? stream.lineage.lineageId : null
  return resolveLineageFullAccess(chat, conversationId, lineageId)
}

export function resolveLineageFullAccess(chat: ChatState, conversationId: string, lineageId?: string | null): FullAccessSubmission {
  return lineageId ? readFullAccessChoice(chat, lineageSettingsKey(conversationId, lineageId)) : restrictedAccess
}
