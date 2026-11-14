import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { AgentsMonitorGrid, getAgentGridCardHeight, getEffectiveCollapsedCells } from './AgentsMonitorGrid'
import { AgentRunPreview as AgentRunPreviewComponent } from './AgentRunPreview'
import { createEmptyStreamState } from '../../features/chats/streamHelpers'
import type { AgentRunPreview } from '../../features/chats/agentRunPreviewSlice'

vi.mock('./AgentFollowUpComposer', () => ({ AgentFollowUpComposer: () => <textarea aria-label='Card follow-up' /> }))
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
  it('uses independent row tracks and omits splitters for single-cell rows', () => {
    const html = render([run('a')])
    expect(html).toContain('grid-template-columns:minmax(min(160px, 100%), 1fr)')
    expect(html).not.toContain('role="separator"')
  })
  it.each([
    [1, 'max(20rem, min(52dvh, 28rem))'],
    [2, 'max(25rem, min(65dvh, 35rem))'],
    [3, 'max(30rem, min(78dvh, 42rem))'],
  ])('scales card height for %i actual grid columns', (columns, height) => {
    expect(getAgentGridCardHeight(columns)).toBe(height)
  })
  it('fills the measured grid viewport regardless of columns, with a minimum', () => {
    expect(getAgentGridCardHeight(3, 900.6)).toBe('max(16rem, 900px)')
    expect(getAgentGridCardHeight(1, 900.6)).toBe('max(16rem, 900px)')
    expect(getAgentGridCardHeight(2, 0)).toBe('max(25rem, min(65dvh, 35rem))')
    expect(getAgentGridCardHeight(2, null)).toBe('max(25rem, min(65dvh, 35rem))')
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
  it('replaces streaming with Chat’s compaction animation only for the compacting fork', () => {
    const active = [run('compacting'), run('other', { lineageId: 'other-fork' })]
    render(active)
    capture.byStreamId.compacting.stream.compactionStatus = 'started'
    const html = renderToStaticMarkup(<AgentsMonitorGrid activeStreams={active} streamHistory={[]} grouped={false} onOpenFork={() => {}} onOpenChat={() => {}} />)
    expect(html.match(/aria-label="Compacting context"/g)).toHaveLength(1)
    expect(html.match(/aria-label="Assistant is working"/g)).toHaveLength(1)
    expect(html).toContain('compaction-progress-fill')
    expect(html).toContain('duration unknown')
  })

  it('shows compaction in selected-run previews even without the grid streaming prop', () => {
    render([run('a')])
    capture.byStreamId.a.stream.compactionStatus = 'started'
    const html = renderToStaticMarkup(<AgentRunPreviewComponent streamId='a' grouped={false} />)
    expect(html).toContain('aria-label="Compacting context"')
    expect(html).not.toContain('Assistant is working')
    expect(html).not.toContain('Waiting for run output')
  })

  it('finds compaction in another active run of a whole-fork preview', () => {
    render([run('a'), run('b')])
    capture.byStreamId.a.stream.compactionStatus = 'started'
    const html = renderToStaticMarkup(<AgentRunPreviewComponent streamId='b' grouped={false} wholeFork isStreaming />)
    expect(html.match(/aria-label="Compacting context"/g)).toHaveLength(1)
    expect(html).not.toContain('Assistant is working')
    const singleRun = renderToStaticMarkup(<AgentRunPreviewComponent streamId='b' grouped={false} isStreaming />)
    expect(singleRun).not.toContain('Compacting context')
    expect(singleRun).toContain('Assistant is working')
  })

  it.each(['completed', 'failed'] as const)('restores streaming after compaction %s', status => {
    render([run('a')])
    capture.byStreamId.a.stream.compactionStatus = status
    const html = renderToStaticMarkup(<AgentRunPreviewComponent streamId='a' grouped={false} isStreaming />)
    expect(html).not.toContain('Compacting context')
    expect(html).toContain('Assistant is working')
    expect(html).not.toContain('compaction-progress-fill')
  })

  it.each([false, true])('renders the shared summary icon/notice without exposing payloads (wholeFork=%s)', wholeFork => {
    themeState.enabled = true
    render([run('a')])
    capture.byStreamId.a.entries.push({ key: 'summary', message: {
      id: 'summary', conversation_id: 'chat-1', role: 'assistant',
      content: 'PRIVATE_SUMMARY_PAYLOAD', content_plain_text: 'PRIVATE_SUMMARY_PAYLOAD',
      content_blocks: [{ type: 'text', index: 0, content: 'PRIVATE_BLOCK_PAYLOAD' }],
      meta: { kind: 'compaction_summary', state: 'committed' },
      children_ids: [], created_at: '2026-10-10T12:01:00Z', model_name: '', partial: false, pastedContext: [], artifacts: [],
    } })
    const html = renderToStaticMarkup(<AgentRunPreviewComponent streamId='a' grouped={false} wholeFork={wholeFork} />)
    expect(html).toContain('Conversation summarised')
    expect(html).toContain('data-chat-summary="true"')
    expect(html).toContain('lucide-archive')
    expect(html).toContain('color:#737373')
    expect(html).not.toContain('PRIVATE_')
    expect(html).not.toContain('Earlier context is preserved for the model.')
    expect(capture.byStreamId.a.entries.at(-1)?.message?.content).toBe('PRIVATE_SUMMARY_PAYLOAD')
  })

  it('never animates a retained completed run with stale compaction state', () => {
    render([], [run('old', { status: 'completed' })])
    capture.byStreamId.old.stream.compactionStatus = 'started'
    const html = renderToStaticMarkup(<AgentRunPreviewComponent streamId='old' grouped={false} />)
    expect(html).not.toContain('Compacting context')
    expect(html).not.toContain('Assistant is working')
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

  const rerender = (active: AgentStreamListItem[], history: AgentStreamListItem[], hiddenForks?: Record<string, string[]>, hiddenListOpen = false) =>
    renderToStaticMarkup(<AgentsMonitorGrid activeStreams={active} streamHistory={history} grouped={false}
      onOpenFork={() => {}} onOpenChat={() => {}} hiddenForks={hiddenForks} onHideFork={() => {}} hiddenListOpen={hiddenListOpen} />)
  // Production previews are immutable (Immer); replace objects so identity caches see the change.
  const replaceRun = (id: string, edit: (run: AgentRunPreview) => void) => {
    const next = structuredClone(capture.byStreamId[id])
    edit(next)
    capture.byStreamId = { ...capture.byStreamId, [id]: next }
  }
  const emptyRun = (id: string, text = '') => replaceRun(id, preview => {
    preview.stream.buffer = text
    preview.entries[0].stream!.buffer = text
  })

  it('omits finished forks with nothing captured but keeps live ones waiting for output', () => {
    const history = [run('empty', { lineageId: 'empty-fork', status: 'completed' }), run('old', { lineageId: 'old-fork', status: 'completed' })]
    render([run('live')], history)
    emptyRun('empty')
    emptyRun('live')
    const html = rerender([run('live')], history)
    expect(html.match(/aria-label="Preview /g)).toHaveLength(2)
    expect(html).toContain('Assistant is working')
    expect(html).toContain('Transcript old')
    expect(html).not.toContain('Waiting for run output')
  })

  it('omits finished forks whose transcript was released and treats whitespace as empty', () => {
    const history = [run('released', { lineageId: 'a', status: 'completed' }), run('blank', { lineageId: 'b', status: 'completed' })]
    render([], history)
    const { released: _released, ...rest } = capture.byStreamId
    capture.byStreamId = rest
    emptyRun('blank', '  \n')
    const html = rerender([], history)
    expect(html).not.toContain('No captured transcript')
    expect(html).toContain('No captured agent forks yet.')
  })

  it('keeps a finished fork whose output is only a tool call', () => {
    const history = [run('tool', { status: 'completed' })]
    render([], history)
    emptyRun('tool')
    replaceRun('tool', preview => { preview.entries[0].stream!.events = [{ type: 'tool_call', toolCall: { id: 't1', name: 'bash', arguments: {} } } as any] })
    expect(rerender([], history)).toContain('aria-label="Preview First chat · fork sam"')
  })

  it('hides user-hidden forks behind a restore list until a new run starts', () => {
    const key = JSON.stringify(['fork', 'chat-1', 'same-fork'])
    const history = [run('old', { status: 'completed' })]
    render([], history)
    const hidden = rerender([], history, { [key]: ['old'] })
    expect(hidden).not.toContain('aria-label="Preview ')
    expect(hidden).not.toContain('Hidden from grid')
    const listed = rerender([], history, { [key]: ['old'] }, true)
    expect(listed).toContain('aria-label="Hidden agent forks"')
    expect(listed).toContain('aria-label="Show First chat · fork sam"')
    expect(listed).toContain('Show all')
    expect(hidden).toContain('All agent forks are hidden.')
    render([run('new')], history)
    const resurfaced = rerender([run('new')], history, { [key]: ['old'] })
    expect(resurfaced).toContain('aria-label="Preview First chat · fork sam"')
    expect(rerender([run('new')], history, { [key]: ['old'] }, true)).not.toContain('Hidden agent forks')
  })

  it('only collapses a card while a row neighbour stays expanded', () => {
    expect(getEffectiveCollapsedCells(['a', 'b', 'c'], new Set(['a']))).toEqual([true, false, false])
    expect(getEffectiveCollapsedCells(['a', 'b'], new Set(['a', 'b']))).toEqual([false, false])
    expect(getEffectiveCollapsedCells(['a'], new Set(['a']))).toEqual([false])
  })

  it('offers no collapse control on a single-card row', () => {
    render([run('a')])
    const html = renderToStaticMarkup(<AgentsMonitorGrid activeStreams={[run('a')]} streamHistory={[]} grouped={false}
      onOpenFork={() => {}} onOpenChat={() => {}} collapsedForks={[JSON.stringify(['fork', 'chat-1', 'same-fork'])]} onToggleForkCollapsed={() => {}} />)
    expect(html).not.toContain('Collapse First chat')
    expect(html).not.toContain('(collapsed)')
    expect(html).toContain('Transcript a')
  })

  it('offers a hide control on each card without nesting buttons', () => {
    render([run('a')])
    const html = rerender([run('a')], [])
    expect(html).toContain('aria-label="Hide First chat · fork sam"')
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/)
  })
})

describe('deferred grid transcripts', () => {
  it('does not construct offscreen transcripts before the first visibility measurement', () => {
    vi.stubGlobal('IntersectionObserver', class {})
    try {
      const html = render(Array.from({ length: 100 }, (_, index) => run(`run-${index}`, { lineageId: `fork-${index}` })))
      expect(html.match(/aria-label="Preview /g)).toHaveLength(100)
      expect(html).not.toContain('Transcript run-')
      expect(html.match(/data-agent-grid-row=/g)).toHaveLength(100)
      expect(html).toContain('height:max(20rem, min(52dvh, 28rem))')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
