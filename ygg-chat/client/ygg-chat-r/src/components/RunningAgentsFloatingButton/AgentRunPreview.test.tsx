import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRunPreview } from './AgentRunPreview'
import { createEmptyStreamState } from '../../features/chats/streamHelpers'
import type { AgentRunPreview as Preview } from '../../features/chats/agentRunPreviewSlice'

const capture = vi.hoisted(() => ({ byStreamId: {} as Record<string, Preview> }))
vi.mock('../../hooks/redux', () => ({ useAppSelector: (selector: (state: any) => unknown) => selector({ agentRunPreviews: capture }) }))
vi.mock('../ChatMessage/ChatMessage', () => ({ ChatMessage: () => null }))
vi.mock('../StreamingThinkingIndicator', () => ({ StreamingThinkingIndicator: ({ compacting }: any) => <span>{compacting ? 'Compacting' : 'Thinking'}</span> }))
vi.mock('../StreamingThinkingIndicator/BackgroundTasksIndicator', () => ({ BackgroundTasksIndicator: ({ streamId, conversationId, tasks, idle }: any) =>
  <span>{`${conversationId}/${streamId}: ${idle ? 'Waiting' : 'Running'} ${tasks.length} tasks`}</span> }))
vi.mock('../ThemeManager/themeConfig', () => ({ useCustomChatTheme: () => ({ enabled: false }), useHtmlDarkMode: () => false }))

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
