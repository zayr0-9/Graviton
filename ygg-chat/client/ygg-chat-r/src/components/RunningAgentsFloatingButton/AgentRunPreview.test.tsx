import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRunPreview } from './AgentRunPreview'
import { createEmptyStreamState } from '../../features/chats/streamHelpers'
import type { AgentRunPreview as Preview } from '../../features/chats/agentRunPreviewSlice'

const capture = vi.hoisted(() => ({ byStreamId: {} as Record<string, Preview> }))
vi.mock('../../hooks/redux', () => ({ useAppSelector: (selector: (state: any) => unknown) => selector({ agentRunPreviews: capture }) }))
vi.mock('../ChatMessage/ChatMessage', () => ({ ChatMessage: ({ role, userSurfaceColor }: any) =>
  <i data-role={role} data-surface={userSurfaceColor} /> }))
vi.mock('../StreamingThinkingIndicator', () => ({ StreamingThinkingIndicator: ({ compacting }: any) => <span>{compacting ? 'Compacting' : 'Thinking'}</span> }))
vi.mock('../StreamingThinkingIndicator/BackgroundTasksIndicator', () => ({ BackgroundTasksIndicator: ({ streamId, conversationId, tasks, idle }: any) =>
  <span>{`${conversationId}/${streamId}: ${idle ? 'Waiting' : 'Running'} ${tasks.length} tasks`}</span> }))
const themeState = vi.hoisted(() => ({ enabled: false, userBg: undefined as { light: string; dark: string } | undefined }))
vi.mock('../ThemeManager/themeConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('../ThemeManager/themeConfig')>()
  return { ...actual, useHtmlDarkMode: () => false, useCustomChatTheme: () => {
    const theme = actual.createDefaultCustomChatTheme()
    if (themeState.userBg) theme.colors.agentsGridUserMessageBg = themeState.userBg
    return { enabled: themeState.enabled, theme }
  } }
})

function addRun(id: string, overrides: Partial<Preview['stream']> = {}) {
  const stream = { ...createEmptyStreamState('branch'), active: true, conversationId: 'chat-1',
    lineage: { lineageId: 'fork-1', lineageIdConfirmed: true }, ...overrides }
  capture.byStreamId = { ...capture.byStreamId, [id]: { streamId: id, stream, projectId: null,
    conversationTitle: null, completedAt: null, entries: [], turn: 0, liveKey: id, partial: false } }
}
const background = { backgroundTurnIdle: true, backgroundTasks: [{ id: 'task-1', toolUseId: 'tool-1', kind: 'workflow' as const, description: 'Check links' }] }
const render = (wholeFork = false) => renderToStaticMarkup(<AgentRunPreview streamId='main' grouped={false} wholeFork={wholeFork} isStreaming />)

describe('preview background activity', () => {
  beforeEach(() => { capture.byStreamId = {} })

  it('replaces thinking with run-scoped background waiting', () => {
    addRun('main', background)
    expect(render()).toContain('chat-1/main: Waiting 1 tasks')
    expect(render()).not.toContain('Thinking')
  })

  it('shows both indicators while Claude is still composing', () => {
    addRun('main', { ...background, backgroundTurnIdle: false })
    expect(render()).toContain('Thinking')
    expect(render()).toContain('Running 1 tasks')
  })

  it('gives compaction precedence over idle background work', () => {
    addRun('main', { ...background, compactionStatus: 'started' })
    expect(render()).toContain('Compacting')
    expect(render()).toContain('Running 1 tasks')
    expect(render()).not.toContain('Waiting 1 tasks')
  })

  it('does not borrow sibling or completed task state', () => {
    addRun('main')
    addRun('sibling', { ...background, lineage: { lineageId: 'fork-2', lineageIdConfirmed: true } })
    addRun('completed', { ...background, active: false })
    expect(render(true)).toContain('Thinking')
    expect(render(true)).not.toContain('tasks')
  })

  it('includes nonrepresentative same-fork tasks without hiding another run thinking', () => {
    addRun('main')
    addRun('older', background)
    expect(render(true)).toContain('chat-1/older: Waiting 1 tasks')
    expect(render(true)).toContain('Thinking')
    expect(render()).not.toContain('tasks')
  })

  it('restores thinking when the task list clears', () => {
    addRun('main', background)
    expect(render()).not.toContain('Thinking')
    addRun('main', { ...background, backgroundTasks: [] })
    expect(render()).toContain('Thinking')
    expect(render()).not.toContain('tasks')
  })
})

describe('preview user message surface', () => {
  beforeEach(() => {
    capture.byStreamId = {}
    themeState.enabled = false
    themeState.userBg = undefined
  })
  const withRequest = () => {
    addRun('main')
    capture.byStreamId.main.entries = [{ key: 'request', message: {
      id: 'request', conversation_id: 'chat-1', role: 'user', content: 'Do it', content_plain_text: 'Do it',
      children_ids: [], created_at: '2026-10-10T12:00:00Z', model_name: '', partial: false, pastedContext: [], artifacts: [],
    } } as any]
  }

  it('right-aligns user bubbles while keeping assistant rows full width', () => {
    withRequest()
    const entries = capture.byStreamId.main.entries
    entries.push({ key: 'reply', message: { ...entries[0].message!, id: 'reply', role: 'assistant', content: 'Done' } })
    const html = render()
    expect(html).toMatch(/<div class="ml-auto w-fit min-w-0 max-w-\[90%\][^"]*"><i data-role="user"/)
    expect(html).toContain('<div class="min-w-0"><i data-role="assistant"')
  })

  it('tints user rows with the default pill colour when no custom theme is on', () => {
    withRequest()
    expect(render()).toContain('data-role="user" data-surface="color-mix(in srgb, currentColor 7%, transparent)"')
  })

  it('uses the custom theme key when a theme is enabled', () => {
    themeState.enabled = true
    themeState.userBg = { light: '#abcdef', dark: '#123456' }
    withRequest()
    expect(render()).toContain('data-surface="#abcdef"')
  })
})
