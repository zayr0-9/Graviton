import { describe, expect, it, vi } from 'vitest'
import type { UiNotification } from '../../features/ui'
import type { AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { getAgentNotificationPreview, getAgentNotificationStreamId } from './agentNotificationTarget'

const notification = (patch: Partial<UiNotification> = {}): UiNotification => ({
  id: 'completion', kind: 'branch_stream_completed', streamId: 'finished-run',
  title: 'Branch finished', conversationId: 'conversation-a', projectId: 'project-a',
  messageId: 'response-a', createdAt: '2026-01-01T10:05:00.000Z', ...patch,
})
const run = (streamId: string, patch: Partial<AgentStreamListItem> = {}): AgentStreamListItem => ({
  streamId, streamType: 'branch', lineageId: 'fork-a', lineageIdConfirmed: true,
  conversationId: 'conversation-a', projectId: 'project-a', conversationTitle: 'Conversation A',
  anchorMessageId: 'old-anchor', hasError: false, createdAt: '2026-01-01T10:00:00.000Z',
  status: 'completed', triggerUserMessageId: null, currentBranchAnchorMessageId: null,
  branchAnchorMessageId: null, liveMessageId: null, streamingMessageId: null,
  lastCompletedMessageId: null, finalMessageId: null, messageId: null, originMessageId: null,
  rootMessageId: null, parentMessageId: null, parentMessageText: null,
  activityKind: 'text', activityLabel: 'text', completedAt: '2026-01-01T10:05:00.000Z',
  displayName: 'agent-1', ...patch,
})

describe('agent completion notification preview', () => {
  it('selects the notified execution, not a newer run in the same fork', () => {
    const build = vi.fn(run)
    const finished = run('finished-run')
    const preview = getAgentNotificationPreview(notification(), [run('newer-run'), finished], build)
    expect(preview).toEqual({ ...finished, anchorMessageId: 'response-a' })
    expect(build).not.toHaveBeenCalled()
  })

  it('opens the exact execution before history catches up or after it is pruned', () => {
    const build = vi.fn(run)
    expect(getAgentNotificationPreview(notification(), [], build)?.streamId).toBe('finished-run')
    expect(build).toHaveBeenCalledWith('finished-run')
  })

  it('does not substitute a newer retained transcript for a superseded execution', () => {
    expect(getAgentNotificationPreview(notification(), [run('newer-run')], run)).toMatchObject({
      streamId: 'finished-run', conversationId: 'conversation-a', projectId: 'project-a',
      anchorMessageId: 'response-a',
    })
  })

  it('matches older notifications by exact response and conversation', () => {
    const old = notification({ streamId: undefined, conversationId: '42', messageId: '7' })
    expect(getAgentNotificationStreamId(old, [
      run('wrong-conversation', { finalMessageId: '7' }),
      run('correct', { conversationId: '42', lastCompletedMessageId: '7' }),
    ])).toBe('correct')
  })

  it('keeps unmatched older completions in the pill with an explicit Open chat target', () => {
    const preview = getAgentNotificationPreview(notification({ streamId: undefined }), [run('unrelated')], run)
    expect(preview).toMatchObject({ streamId: 'notification:completion', anchorMessageId: 'response-a' })
  })

  it('preserves the resolved project when the notification has no project metadata', () => {
    expect(getAgentNotificationPreview(notification({ projectId: null }), [run('finished-run')], run)?.projectId).toBe('project-a')
  })

  it('leaves watcher notifications on their existing direct-navigation path', () => {
    const build = vi.fn(run)
    expect(getAgentNotificationPreview(notification({ kind: 'watch_completed' }), [], build)).toBeNull()
    expect(build).not.toHaveBeenCalled()
  })
})
