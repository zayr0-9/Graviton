export const MAX_FOLLOW_UP_LENGTH = 200_000
export const MAX_FOLLOW_UP_DRAFTS = 200
export const MAX_FOLLOW_UP_TOTAL = 2_000_000

export interface AgentFollowUpAttempt {
  conversationId: string
  streamId: string
  content: string
  requestId: string
  revision: number
  preparedTextSubmission: { epoch: string; fullAccess: boolean; fullAccessNotificationId?: string }
}

export interface AgentFollowUpDraft {
  content: string
  revision: number
  streamIds: string[]
  status: 'idle' | 'preparing' | 'sending' | 'unknown' | 'rejected' | 'accepted'
  attempt?: AgentFollowUpAttempt
  acceptedStreamId?: string
  error?: string
  policy?: boolean
}

export const emptyFollowUpDraft = (): AgentFollowUpDraft => ({ content: '', revision: 0, streamIds: [], status: 'idle' })

export function relatedFollowUpKeys(drafts: Record<string, AgentFollowUpDraft>, key: string, streamIds: readonly string[]): string[] {
  return Object.keys(drafts).filter(candidate => candidate === key || drafts[candidate].streamIds.some(id => id === key || streamIds.includes(id)))
}

/** Preserve the original key across lineage confirmation and successor regrouping. */
export function findFollowUpKey(drafts: Record<string, AgentFollowUpDraft>, key: string, streamIds: readonly string[]): string {
  if (drafts[key]) return key
  return Object.keys(drafts).find(candidate => drafts[candidate].streamIds.some(id => id === key || streamIds.includes(id))) ?? key
}

export function followUpCapacity(drafts: Record<string, AgentFollowUpDraft>, key: string, content: string): boolean {
  if (content.length > MAX_FOLLOW_UP_LENGTH) return false
  if (!drafts[key] && Object.keys(drafts).length >= MAX_FOLLOW_UP_DRAFTS) return false
  return Object.entries(drafts).reduce((total, [id, draft]) => total + (id === key ? 0 : draft.content.length) +
    (draft.attempt?.content.length ?? 0), content.length) <= MAX_FOLLOW_UP_TOTAL
}
