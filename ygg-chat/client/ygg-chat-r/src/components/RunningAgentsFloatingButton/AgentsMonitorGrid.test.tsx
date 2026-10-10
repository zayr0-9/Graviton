import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { AgentsMonitorGrid } from './AgentsMonitorGrid'
import { createEmptyStreamState } from '../../features/chats/streamHelpers'
import type { AgentRunPreview } from '../../features/chats/agentRunPreviewSlice'

const capture = vi.hoisted(() => ({ byStreamId: {} as Record<string, AgentRunPreview> }))
vi.mock('../../hooks/redux', () => ({ useAppSelector: (selector: (state: any) => unknown) => selector({ agentRunPreviews: capture }) }))
vi.mock('../ChatMessage/ChatMessage', () => ({ ChatMessage: ({ contentBlocks }: any) => <p>{contentBlocks.filter((block: any) => block.type === 'text').map((block: any) => block.content).join(' ')}</p> }))

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
const render = (active: AgentStreamListItem[], history: AgentStreamListItem[] = [], grouped = false) => {
  capture.byStreamId = Object.fromEntries([...history, ...active].map(item => {
    const stream = { ...createEmptyStreamState('branch'), conversationId: item.conversationId,
      active: active.some(candidate => candidate.streamId === item.streamId), createdAt: item.createdAt,
      lineage: { lineageId: item.lineageId ?? undefined, lineageIdConfirmed: item.lineageIdConfirmed }, buffer: `Transcript ${item.streamId}` }
    return [item.streamId, { streamId: item.streamId, stream, projectId: null, conversationTitle: item.conversationTitle,
      completedAt: item.completedAt, entries: [{ key: `${item.streamId}:turn:0`, stream }], turn: 0,
      liveKey: `${item.streamId}:turn:0`, partial: false }]
  }))
  return renderToStaticMarkup(<AgentsMonitorGrid activeStreams={active} streamHistory={history} grouped={grouped} onOpenFork={() => {}} onOpenChat={() => {}} />)
}

describe('fork grid', () => {
  it('shows one card for concurrent and historical runs on the same fork', () => {
    const html = render([run('a'), run('b')], [run('old', { status: 'completed' })])
    expect(html.match(/aria-label="Preview /g)).toHaveLength(1)
    expect(html).toContain('2 running · 1 completed runs')
    expect(html).not.toContain('1 active · 0 completed')
    expect(html).toContain('Transcript a')
    expect(html).toContain('Transcript b')
    expect(html).toContain('Transcript old')
    expect(html).not.toContain('captured runs, oldest first')
  })
  it('keeps different conversations and unresolved runs separate', () => {
    const html = render([run('a'), run('b', { conversationId: 'other' }), run('c', { lineageIdConfirmed: false })])
    expect(html.match(/aria-label="Preview /g)).toHaveLength(3)
    expect(html).not.toContain('captured runs, oldest first')
    for (const id of ['a', 'b', 'c']) expect(html).toContain(`Transcript ${id}`)
    expect(html.match(/overscroll-contain px-1 pb-3/g)).toHaveLength(3)
  })
  it('shows completed-only forks without a dialog or per-run dismiss controls', () => {
    const html = render([], [run('old', { status: 'completed' })])
    expect(html).toContain('Completed')
    expect(html).toContain('Transcript old')
    expect(html).not.toContain('0 active · 1 completed')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('Dismiss run')
  })
  it('keeps the latest active representative even when older history exists', () => {
    const live = run('live', { createdAt: '2026-10-10T13:00:00Z' })
    const groups = buildAgentForkGroups([live], [run('old', { status: 'completed' })])
    expect(groups.activeForks[0].representative).toBe(live)
    expect(groups.activeForks).toHaveLength(1)
  })
  it('uses responsive column caps while retaining a minimum card width', () => {
    const html = render([run('a')])
    expect(html).toContain('grid-cols-1')
    expect(html).toContain('md:[grid-template-columns:repeat(auto-fit,minmax(min(100%,max(18rem,calc((100%_-_0.75rem)/2))),1fr))]')
    expect(html).toContain('xl:[grid-template-columns:repeat(auto-fit,minmax(min(100%,max(18rem,calc((100%_-_1.5rem)/3))),1fr))]')
  })
  it('offers a separate chat button beside status for active and completed forks', () => {
    const html = render([run('a')], [run('old', { lineageId: 'other-fork', status: 'completed' })])
    expect(html.match(/Open chat ↗/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Open chat for First chat · fork sam"')
    expect(html).toContain('Writing')
    expect(html).toContain('Completed')
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/)
  })
  it('disables chat navigation when the conversation is unknown', () => {
    const html = render([run('a', { conversationId: null })])
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Open chat for/)
  })
  it('leaves the grouping control to the expanded pill top bar', () => {
    expect(render([run('a')])).not.toContain('Group steps')
    expect(render([run('a')], [], true)).not.toContain('Group steps')
  })
  it('omits transcript metadata and the redundant expand text', () => {
    render([run('a')])
    capture.byStreamId.a.partial = true
    const html = renderToStaticMarkup(<AgentsMonitorGrid activeStreams={[run('a')]} streamHistory={[]} grouped={false} onOpenFork={() => {}} onOpenChat={() => {}} />)
    expect(html).not.toContain('captured runs, oldest first')
    expect(html).not.toContain('Recovered preview may omit earlier turns')
    expect(html).not.toContain('Run started')
    expect(html).not.toContain('Expand fork transcript')
    expect(html).not.toContain('role="status"')
    expect(html).toContain('Transcript a')
    expect(html).toContain('aria-label="Preview First chat · fork sam"')
  })
  it('has an empty state', () => { expect(render([])).toContain('No captured agent forks yet.') })
})
