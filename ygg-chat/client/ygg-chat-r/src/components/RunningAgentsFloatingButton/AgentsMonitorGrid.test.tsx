import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { AgentsMonitorGrid } from './AgentsMonitorGrid'

vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ enabled: false, theme: { colors: {} } }),
  useHtmlDarkMode: () => false, getThemeModeColor: () => undefined,
}))
vi.mock('./AgentMessageTooltip', () => ({ AgentMessageTooltip: ({ children }: { children: ReactNode }) => <>{children}</> }))

const run = (streamId: string, overrides: Partial<AgentStreamListItem> = {}): AgentStreamListItem => ({
  streamId, streamType: 'branch', lineageId: 'same-fork', lineageIdConfirmed: true,
  conversationId: 'chat-1', projectId: 'project-1', conversationTitle: 'First chat',
  anchorMessageId: null, hasError: false, createdAt: '2026-10-10T12:00:00Z', status: 'active',
  triggerUserMessageId: null, currentBranchAnchorMessageId: null, branchAnchorMessageId: null,
  liveMessageId: null, streamingMessageId: null, lastCompletedMessageId: null, finalMessageId: null,
  messageId: null, originMessageId: null, rootMessageId: null, parentMessageId: null,
  parentMessageText: 'Inspect this task', activityKind: 'text', activityLabel: 'Writing',
  completedAt: null, displayName: streamId, ...overrides,
})
const render = (active: AgentStreamListItem[], history: AgentStreamListItem[] = []) => renderToStaticMarkup(
  <AgentsMonitorGrid activeStreams={active} streamHistory={history} onOpenFork={() => {}} />
)

describe('fork grid', () => {
  it('shows one card for concurrent and historical runs on the same fork', () => {
    const html = render([run('a'), run('b')], [run('old', { status: 'completed' })])
    expect(html.match(/View full fork transcript/g)).toHaveLength(1)
    expect(html).toContain('2 running · 1 completed runs')
    expect(html).toContain('1 active · 0 completed')
  })
  it('keeps different conversations and unresolved runs separate', () => {
    const html = render([run('a'), run('b', { conversationId: 'other' }), run('c', { lineageIdConfirmed: false })])
    expect(html.match(/View full fork transcript/g)).toHaveLength(3)
  })
  it('shows completed-only forks without a dialog or per-run dismiss controls', () => {
    const html = render([], [run('old', { status: 'completed' })])
    expect(html).toContain('Completed')
    expect(html).toContain('0 active · 1 completed')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('Dismiss run')
  })
  it('keeps the latest active representative even when older history exists', () => {
    const live = run('live', { createdAt: '2026-10-10T13:00:00Z' })
    const groups = buildAgentForkGroups([live], [run('old', { status: 'completed' })])
    expect(groups.activeForks[0].representative).toBe(live)
    expect(groups.activeForks).toHaveLength(1)
  })
  it('has an empty state', () => { expect(render([])).toContain('No captured agent forks yet.') })
})
