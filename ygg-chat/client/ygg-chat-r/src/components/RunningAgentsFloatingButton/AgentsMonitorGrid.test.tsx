import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { AgentsMonitorGrid, getAgentGridCardHeight } from './AgentsMonitorGrid'
import { createEmptyStreamState } from '../../features/chats/streamHelpers'
import type { AgentRunPreview } from '../../features/chats/agentRunPreviewSlice'

const capture = vi.hoisted(() => ({ byStreamId: {} as Record<string, AgentRunPreview> }))
vi.mock('../../hooks/redux', () => ({ useAppSelector: (selector: (state: any) => unknown) => selector({ agentRunPreviews: capture }) }))
vi.mock('../ChatMessage/ChatMessage', () => ({ ChatMessage: ({ contentBlocks }: any) => <p>{contentBlocks.filter((block: any) => block.type === 'text').map((block: any) => block.content).join(' ')}</p> }))

const themeState = vi.hoisted(() => ({ enabled: false, dark: false, overrideCardColors: true }))
vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return {
    ...actual,
    useCustomChatTheme: () => ({ enabled: themeState.enabled, theme: {
      ...actual.createDefaultCustomChatTheme(),
      colors: {
        ...actual.createDefaultCustomChatTheme().colors,
        composerToggleActiveBg: { light: '#ffeedd', dark: '#332211' },
        settingsCustomThemesInnerCardBg: { light: '#f0f0f0', dark: '#202020' },
        ...(themeState.overrideCardColors ? {
          agentsGridStreamingCardBg: { light: '#aabbcc', dark: '#112233' },
          agentsGridIdleCardBg: { light: '#ddeeff', dark: '#445566' },
        } : {}),
      },
    } }),
    useHtmlDarkMode: () => themeState.dark,
  }
})
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
  beforeEach(() => {
    themeState.enabled = false
    themeState.dark = false
    themeState.overrideCardColors = true
  })

  it('distinguishes streaming and idle cards without a custom theme', () => {
    const html = render([run('live')], [run('old', { lineageId: 'other-fork', status: 'completed' })])
    expect(html).toContain('bg-orange-50 dark:bg-orange-900/20')
    expect(html).toContain('bg-black/[0.035] dark:bg-white/5')
  })

  it.each([false, true])('borrows the current custom theme palette by default (dark=%s)', dark => {
    themeState.enabled = true
    themeState.dark = dark
    themeState.overrideCardColors = false
    const html = render([run('live')], [run('old', { lineageId: 'other-fork', status: 'completed' })])
    expect(html).toContain(`--agents-grid-streaming-bg:${dark ? '#332211' : '#ffeedd'}`)
    expect(html).toContain(`--agents-grid-idle-bg:${dark ? '#202020' : '#f0f0f0'}`)
    expect(html).toContain('background-color:var(--agents-grid-streaming-bg)')
    expect(html).toContain('background-color:var(--agents-grid-idle-bg)')
    expect(html).not.toContain('rgba(16, 185, 129')
  })

  it.each([false, true])('uses independent custom card backgrounds and updates after completion (dark=%s)', dark => {
    themeState.enabled = true
    themeState.dark = dark
    const streamingColor = dark ? '#112233' : '#aabbcc'
    const idleColor = dark ? '#445566' : '#ddeeff'
    const live = run('live')
    const html = render([live], [run('old', { lineageId: 'other-fork', status: 'completed', hasError: true })])
    expect(html).toContain(`background-color:${streamingColor}`)
    expect(html).toContain(`background-color:${idleColor}`)
    const completed = render([], [{ ...live, status: 'completed' }])
    expect(completed).toContain(`background-color:${idleColor}`)
    expect(completed).not.toContain(`background-color:${streamingColor}`)
  })

  it('keeps the streaming background while any same-fork run is active', () => {
    themeState.enabled = true
    const html = render([run('live')], [run('old', { status: 'completed' })])
    expect(html.match(/aria-label="Preview /g)).toHaveLength(1)
    expect(html).toContain('background-color:#aabbcc')
    expect(html).not.toContain('background-color:#ddeeff')
  })
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
  it.each([
    [1, 'max(20rem, min(52dvh, 28rem))'],
    [2, 'max(25rem, min(65dvh, 35rem))'],
    [3, 'max(30rem, min(78dvh, 42rem))'],
  ])('scales card height for %i actual grid columns', (columns, height) => {
    expect(getAgentGridCardHeight(columns)).toBe(height)
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
  it('reuses Chat’s streaming animation only for active forks', () => {
    const html = render([run('a')], [run('old', { lineageId: 'other-fork', status: 'completed' })])
    expect(html.match(/aria-label="Assistant is working"/g)).toHaveLength(1)
    expect(html).toContain('tool-name-shimmer')
    expect(html).toContain('Thinking')
    expect(html.indexOf('Transcript a')).toBeLessThan(html.indexOf('aria-label="Assistant is working"'))
    expect(render([], [run('old', { status: 'completed' })])).not.toContain('Assistant is working')
  })
  it('shows the animation while waiting for the first streaming output', () => {
    render([run('a')])
    const preview = capture.byStreamId.a
    preview.stream.buffer = ''
    preview.entries[0].stream.buffer = ''
    const html = renderToStaticMarkup(<AgentsMonitorGrid activeStreams={[run('a')]} streamHistory={[]} grouped={false} onOpenFork={() => {}} onOpenChat={() => {}} />)
    expect(html).toContain('Assistant is working')
    expect(html).not.toContain('Waiting for run output')
  })
  it('wraps long user paths within narrow preview cards without changing assistant code layout', () => {
    render([run('a')])
    const path = '@/Users/karansingh/Projects/Graviton/ygg-chat/client/ygg-chat-r/src/containers/Settings.tsx'
    capture.byStreamId.a.entries.unshift({ key: 'request', message: {
      id: 'request', conversation_id: 'chat-1', role: 'user', content: `Update ${path}`,
      content_plain_text: `Update ${path}`, children_ids: [], created_at: '2026-10-10T12:00:00Z',
      model_name: '', partial: false, pastedContext: [], artifacts: [],
    } })
    const html = renderToStaticMarkup(<AgentsMonitorGrid activeStreams={[run('a')]} streamHistory={[]} grouped={false} onOpenFork={() => {}} onOpenChat={() => {}} />)
    expect(html).toContain(path)
    expect(html.match(/\[&amp;_\.chat-markdown\]:\[overflow-wrap:anywhere\]/g)).toHaveLength(1)
    expect(html).toContain('Transcript a')
  })
  it('has an empty state', () => { expect(render([])).toContain('No captured agent forks yet.') })
})
