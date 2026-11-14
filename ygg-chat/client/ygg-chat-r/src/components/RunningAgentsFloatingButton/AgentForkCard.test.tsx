import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentForkGroups, type AgentStreamListItem } from '../../hooks/useRunningAgentStreams'
import { AgentForkCard, getAgentCardStatus, resolvePreviewFork } from './AgentForkCard'
import { createEmptyStreamState } from '../../features/chats/streamHelpers'
import type { AgentRunPreview } from '../../features/chats/agentRunPreviewSlice'

vi.mock('./AgentFollowUpComposer', () => ({ AgentFollowUpComposer: () => <textarea aria-label='Card follow-up' /> }))
const capture = vi.hoisted(() => ({ byStreamId: {} as Record<string, AgentRunPreview> }))
vi.mock('../../hooks/redux', () => ({ useAppSelector: (selector: (state: any) => unknown) => selector({ agentRunPreviews: capture }) }))
vi.mock('../ChatMessage/ChatMessage', () => ({ ChatMessage: ({ contentBlocks }: any) => <p>{contentBlocks.filter((block: any) => block.type === 'text').map((block: any) => block.content).join(' ')}</p> }))
vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return { ...actual, useCustomChatTheme: () => ({ enabled: false, theme: actual.createDefaultCustomChatTheme() }), useHtmlDarkMode: () => false }
})
vi.mock('./AgentMessageTooltip', () => ({ AgentMessageTooltip: ({ children }: { children: ReactNode }) => <>{children}</> }))

const run = (streamId: string, overrides: Partial<AgentStreamListItem> = {}): AgentStreamListItem => ({
  streamId, streamType: 'branch', lineageId: 'same-fork', lineageIdConfirmed: true,
  conversationId: 'chat-1', projectId: 'project-1', conversationTitle: 'First chat',
  anchorMessageId: null, hasError: false, createdAt: '2026-10-10T12:00:00Z', status: 'active',
  triggerUserMessageId: null, currentBranchAnchorMessageId: null, branchAnchorMessageId: null,
  liveMessageId: null, streamingMessageId: null, lastCompletedMessageId: null, finalMessageId: null,
  messageId: null, originMessageId: null, rootMessageId: null, parentMessageId: null,
  parentMessageText: `Request ${streamId}`, activityKind: 'text', activityLabel: 'Writing',
  completedAt: null, displayName: streamId, ...overrides,
})

/** Retained previews mirror the stream list, with one line of output per run. */
function capturePreviews(active: AgentStreamListItem[], history: AgentStreamListItem[] = []) {
  capture.byStreamId = Object.fromEntries([...history, ...active].map(item => {
    const stream = { ...createEmptyStreamState('branch'), conversationId: item.conversationId,
      active: active.includes(item), createdAt: item.createdAt,
      lineage: { lineageId: item.lineageId ?? undefined, lineageIdConfirmed: item.lineageIdConfirmed }, buffer: `Transcript ${item.streamId}` }
    return [item.streamId, { streamId: item.streamId, stream, projectId: null, conversationTitle: item.conversationTitle,
      completedAt: item.completedAt, entries: [{ key: `${item.streamId}:turn:0`, stream }], turn: 0,
      liveKey: `${item.streamId}:turn:0`, partial: false }]
  }))
}
const forkOf = (active: AgentStreamListItem[], history: AgentStreamListItem[] = []) => {
  const { activeForks, historyForks } = buildAgentForkGroups(active, history)
  return [...activeForks, ...historyForks][0]
}
const WORKING = 'aria-label="Assistant is working"'

describe('AgentForkCard', () => {
  beforeEach(() => { capture.byStreamId = {} })

  it('shows the working indicator in both the grid cell and the focused preview', () => {
    const live = run('live')
    capturePreviews([live])
    const fork = forkOf([live])
    const cell = renderToStaticMarkup(<AgentForkCard fork={fork} grouped={false} onOpen={() => {}} onOpenChat={() => {}}
      actions={<button type='button'>Hide</button>} />)
    const focused = renderToStaticMarkup(<AgentForkCard fork={fork} grouped={false} onOpenChat={() => {}} fillHeight={false}
      leading={<button type='button'>Back</button>} />)
    for (const html of [cell, focused]) {
      expect(html).toContain(WORKING)
      expect(html).toContain('Writing')
      expect(html).toContain('1 running · 0 completed runs')
      expect(html).toContain('Request live')
      expect(html).toContain('aria-label="Open chat for First chat · fork sam"')
      expect(html).toContain('Transcript live')
    }
  })

  it('makes the title a preview button only when it can open one', () => {
    const live = run('live')
    capturePreviews([live])
    const fork = forkOf([live])
    expect(renderToStaticMarkup(<AgentForkCard fork={fork} grouped={false} onOpen={() => {}} onOpenChat={() => {}} />))
      .toContain('aria-label="Preview First chat · fork sam"')
    expect(renderToStaticMarkup(<AgentForkCard fork={fork} grouped={false} onOpenChat={() => {}} />))
      .not.toContain('aria-label="Preview ')
  })

  it('shows a finished fork without the working indicator', () => {
    const done = run('done', { status: 'completed', completedAt: '2026-10-10T12:05:00Z' })
    capturePreviews([], [done])
    const html = renderToStaticMarkup(<AgentForkCard fork={forkOf([], [done])} grouped={false} onOpenChat={() => {}} />)
    expect(html).toContain('Completed')
    expect(html).not.toContain(WORKING)
  })

  it('previews one completed run of a live fork without borrowing its activity', () => {
    const live = run('live', { createdAt: '2026-10-10T12:10:00Z' })
    const older = run('older', { status: 'completed', completedAt: '2026-10-10T12:05:00Z' })
    capturePreviews([live], [older])
    const fork = forkOf([live], [older])
    const html = renderToStaticMarkup(<AgentForkCard fork={fork} run={older} grouped={false} onOpenChat={() => {}} />)
    expect(getAgentCardStatus(fork, older)).toEqual({ active: false, hasError: false, label: 'Completed' })
    expect(html).toContain('Run older')
    expect(html).toContain('Request older')
    expect(html).toContain('Transcript older')
    expect(html).not.toContain('Transcript live')
    expect(html).not.toContain(WORKING)
  })

  it('reports errors ahead of activity', () => {
    const failed = run('failed', { hasError: true })
    expect(getAgentCardStatus(forkOf([failed]))).toEqual({ active: true, hasError: true, label: 'Ended with error' })
  })

  it('defers the transcript but keeps the header when not mounted', () => {
    const live = run('live')
    capturePreviews([live])
    const html = renderToStaticMarkup(<AgentForkCard fork={forkOf([live])} grouped={false} onOpenChat={() => {}} mountTranscript={false} />)
    expect(html).toContain('Writing')
    expect(html).not.toContain('Transcript live')
  })
})

describe('resolvePreviewFork', () => {
  it('follows the fork to its newest live run', () => {
    const clicked = run('clicked', { status: 'completed', completedAt: '2026-10-10T12:05:00Z' })
    const newer = run('newer', { createdAt: '2026-10-10T12:10:00Z' })
    const fork = resolvePreviewFork(clicked, [newer], [clicked])
    expect(fork.representative.streamId).toBe('newer')
    expect(fork.activeStreams.map(stream => stream.streamId)).toEqual(['newer'])
    expect(fork.completedStreams.map(stream => stream.streamId)).toEqual(['clicked'])
  })

  it('ignores sibling forks', () => {
    const clicked = run('clicked')
    const sibling = run('sibling', { lineageId: 'other-fork', createdAt: '2026-10-10T12:10:00Z' })
    expect(resolvePreviewFork(clicked, [clicked, sibling], []).representative.streamId).toBe('clicked')
  })

  it('shows an unlisted notification run on its own', () => {
    const gone = run('gone', { status: 'completed', completedAt: '2026-10-10T12:05:00Z' })
    const fork = resolvePreviewFork(gone, [run('other', { lineageId: 'other-fork' })], [])
    expect(fork.representative.streamId).toBe('gone')
    expect(fork.activeStreams).toHaveLength(0)
  })
})
