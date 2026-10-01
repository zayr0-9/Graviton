import { describe, expect, it } from 'vitest'
import type { Conversation } from '../features/conversations/conversationTypes'
import { createEmptyStreamState } from '../features/chats/streamHelpers'
import {
  buildAgentConversationLookup,
  buildAgentForkGroups,
  getAgentForkKey,
  retainAgentParentPreview,
  refreshAgentStreamHistory,
  type AgentStreamListItem,
} from './useRunningAgentStreams'

const conversation = (id: string, title: string, projectId: string): Conversation => ({
  id,
  user_id: 'user-1',
  title,
  project_id: projectId,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  system_prompt: null,
  conversation_context: null,
  research_note: null,
})

describe('buildAgentConversationLookup', () => {
  it('retains an originating conversation when route-scoped Redux data moves to another project', () => {
    const conversationA = conversation('conversation-a', 'Conversation A', 'project-a')
    const conversationB = conversation('conversation-b', 'Conversation B', 'project-b')

    const lookup = buildAgentConversationLookup([conversationA, conversationB], [conversationB])

    expect(lookup.get('conversation-a')).toMatchObject({
      title: 'Conversation A',
      project_id: 'project-a',
    })
  })

  it('prefers current route data over a stale global conversation record', () => {
    const staleConversation = conversation('conversation-a', 'Old title', 'project-a')
    const currentConversation = conversation('conversation-a', 'Updated title', 'project-a')

    const lookup = buildAgentConversationLookup([staleConversation], [currentConversation])

    expect(lookup.get('conversation-a')?.title).toBe('Updated title')
  })
})


describe('retainAgentParentPreview', () => {
  it('keeps the originating message preview when navigation removes that conversation messages from Redux', () => {
    const cached = { messageId: 'message-a', text: 'Original request from conversation A' }

    expect(retainAgentParentPreview({ messageId: null, text: null }, cached)).toEqual(cached)
  })

  it('uses a currently resolved preview instead of stale cached content', () => {
    const current = { messageId: 'message-a', text: 'Updated request' }
    const cached = { messageId: 'message-a', text: 'Old request' }

    expect(retainAgentParentPreview(current, cached)).toEqual(current)
  })
})

const run = (streamId: string, patch: Partial<AgentStreamListItem> = {}): AgentStreamListItem => ({
  streamId, streamType: 'primary', lineageId: 'fork-a', lineageIdConfirmed: true,
  conversationId: 'conversation-a', projectId: 'project-a', conversationTitle: 'Conversation A',
  anchorMessageId: `${streamId}-anchor`, hasError: false, createdAt: '2026-01-01T10:00:00.000Z',
  status: 'active', triggerUserMessageId: null, currentBranchAnchorMessageId: null,
  branchAnchorMessageId: null, liveMessageId: null, streamingMessageId: null,
  lastCompletedMessageId: null, finalMessageId: null, messageId: null, originMessageId: null,
  rootMessageId: 'shared-root', parentMessageId: null, parentMessageText: `${streamId} request`,
  activityKind: 'text', activityLabel: 'text', completedAt: null, displayName: 'agent-1',
  ...patch,
})
const completed = (streamId: string, patch: Partial<AgentStreamListItem> = {}) =>
  run(streamId, { status: 'completed', completedAt: '2026-01-01T10:05:00.000Z', ...patch })

describe('fork-grouped agent presentation', () => {
  it('collapses consecutive completed sends into one fork with the latest navigation target', () => {
    const older = completed('older')
    const latest = completed('latest', { createdAt: '2026-01-01T11:00:00.000Z' })
    const { activeForks, historyForks } = buildAgentForkGroups([], [older, latest])
    expect(activeForks).toEqual([])
    expect(historyForks).toHaveLength(1)
    expect(historyForks[0].completedStreams).toEqual([latest, older])
    expect(historyForks[0].representative).toBe(latest)
    expect(historyForks[0].representative.anchorMessageId).toBe('latest-anchor')
    expect(historyForks[0].representative.parentMessageText).toBe('latest request')
  })

  it('keeps recent history with an active fork without a duplicate History row', () => {
    const active = run('active')
    const past = completed('past')
    const result = buildAgentForkGroups([active], [past])
    expect(result.activeForks).toHaveLength(1)
    expect(result.historyForks).toEqual([])
    expect(result.activeForks[0].representative).toBe(active)
    expect(result.activeForks[0].completedStreams).toEqual([past])
  })

  it('separates sibling forks and conversations even when they share roots or lineage strings', () => {
    const result = buildAgentForkGroups([
      run('a'), run('b', { lineageId: 'fork-b' }),
      run('c', { conversationId: 'conversation-b' }),
    ], [])
    expect(result.activeForks).toHaveLength(3)
    expect(new Set(result.activeForks.map(fork => fork.key)).size).toBe(3)
  })

  it('keeps missing and unconfirmed identities separate until the server resolves them', () => {
    const source = run('source')
    const pending = run('pending', { lineageIdConfirmed: false })
    expect(buildAgentForkGroups([source, pending, run('missing', { lineageId: null })], []).activeForks)
      .toHaveLength(3)
    const confirmed = { ...pending, lineageId: 'fork-b', lineageIdConfirmed: true }
    expect(buildAgentForkGroups([source, confirmed], []).activeForks).toHaveLength(2)
    expect(buildAgentForkGroups([source, { ...confirmed, lineageId: 'fork-a' }], []).activeForks)
      .toHaveLength(1)
    expect(getAgentForkKey(run('no-conversation', { conversationId: null }))).toContain('run')
  })

  it('retains multiple executions and aggregates active errors, without stale history errors', () => {
    const newer = run('newer', { createdAt: '2026-01-01T11:00:00.000Z' })
    const older = run('older', { hasError: true })
    const history = completed('past', { hasError: true })
    const result = buildAgentForkGroups([older, newer], [history])
    expect(result.activeForks[0].activeStreams).toEqual([newer, older])
    expect(result.activeForks[0].representative).toBe(newer)
    expect(result.activeForks[0].hasError).toBe(true)
    expect(buildAgentForkGroups([newer], [history]).activeForks[0].hasError).toBe(false)
    expect(buildAgentForkGroups([], [newer, history]).historyForks[0].hasError).toBe(false)
  })

  it('orders forks by latest run and keeps stable keys/labels when list order changes', () => {
    const a = run('a')
    const b = run('b', { lineageId: 'fork-b', createdAt: '2026-01-01T11:00:00.000Z' })
    const first = buildAgentForkGroups([a, b], []).activeForks
    const second = buildAgentForkGroups([b, a], []).activeForks
    expect(first).toEqual(second)
    expect(first.map(fork => fork.lineageId)).toEqual(['fork-b', 'fork-a'])
    expect(first[1].displayName).toBe('fork fork-a')
    expect(a.displayName).toBe('agent-1')
  })

  it('does not duplicate a resumed active run also present in recent history', () => {
    const result = buildAgentForkGroups([run('same')], [completed('same')])
    expect(result.activeForks[0].activeStreams).toHaveLength(1)
    expect(result.activeForks[0].completedStreams).toEqual([])
    expect(buildAgentForkGroups([], [])).toEqual({ activeForks: [], historyForks: [] })
  })
})

describe('refreshAgentStreamHistory', () => {
  it('refreshes late identity/error/anchor events while preserving completion time', () => {
    const snapshot = completed('late', { lineageIdConfirmed: false })
    const terminal = { ...createEmptyStreamState('primary'), active: false }
    const refreshed = refreshAgentStreamHistory([snapshot], { late: terminal }, (_id, _stream, completedAt) => ({
      ...snapshot, lineageIdConfirmed: true, hasError: true, anchorMessageId: 'final-anchor', completedAt,
    }))
    expect(refreshed[0]).toMatchObject({
      lineageIdConfirmed: true, hasError: true, anchorMessageId: 'final-anchor', completedAt: snapshot.completedAt,
    })
    expect(buildAgentForkGroups([run('next')], refreshed).activeForks).toHaveLength(1)
    expect(buildAgentForkGroups([run('next')], refreshed).historyForks).toEqual([])
  })

  it('retains pruned/resumed snapshots and avoids state churn when nothing changed', () => {
    const history = [completed('past')]
    const buildItem = () => ({ ...history[0] })
    expect(refreshAgentStreamHistory(history, {}, buildItem)).toBe(history)
    expect(refreshAgentStreamHistory(history, { past: createEmptyStreamState('primary') }, buildItem)).toBe(history)
    expect(refreshAgentStreamHistory(history, {
      past: { ...createEmptyStreamState('primary'), active: true },
    }, () => run('past'))).toBe(history)
  })
})
