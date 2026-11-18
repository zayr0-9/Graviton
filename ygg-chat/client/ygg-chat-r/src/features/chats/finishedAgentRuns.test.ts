import './__testSupport__/localStorageShim' // chatSlice reads localStorage at import
import { afterEach, describe, expect, it, vi } from 'vitest'
import reducer, { agentRunPreviewActions, MAX_FINISHED_AGENT_FORKS, previewForkKey, type AgentRunPreviewState } from './agentRunPreviewSlice'
import { finishedRunStream, pickFinishedRunsToInstall, syncFinishedAgentRuns, type FinishedAgentRun } from './finishedAgentRuns'

vi.mock('../../utils/api', () => ({ buildLocalApiUrl: async (path: string) => `http://host/api${path}` }))

const run = (streamId: string, lineageId: string | null, createdAt: string, extra: Partial<FinishedAgentRun> = {}): FinishedAgentRun => ({
  streamId, conversationId: 'c', lineageId, parentId: 'prior', createdAt, completedAt: createdAt, status: 'completed', operationMode: 'execute', ...extra,
})
const empty: AgentRunPreviewState = { byStreamId: {}, latestByFork: {} }
const message = (id: string, role: 'user' | 'assistant', parent_id: string | null) =>
  ({ id, role, parent_id, conversation_id: 'c', content: id, children_ids: [] }) as any

const installed = (state: AgentRunPreviewState, item: FinishedAgentRun, messages = [message('u', 'user', 'prior'), message('a', 'assistant', 'u')]) =>
  reducer(state, agentRunPreviewActions.finishedRunInstalled({ streamId: item.streamId, stream: finishedRunStream(item),
    messages: [...messages].reverse(), projectId: null, conversationTitle: null, completedAt: item.completedAt }))

describe('finished agent runs', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('picks the newest run of each recent fork, skipping live, retained and tried forks', () => {
    const runs = [
      run('old', 'l1', '2026-01-01T00:00:00Z'),
      run('new', 'l1', '2026-01-02T00:00:00Z'),
      run('live', 'l2', '2026-01-03T00:00:00Z'),
      run('tried', 'l3', '2026-01-04T00:00:00Z'),
      run('retained', 'l4', '2026-01-05T00:00:00Z'),
      run('unconfirmed', null, '2026-01-06T00:00:00Z'),
    ]
    const retained = installed(empty, run('kept', 'l4', '2026-01-06T00:00:00Z'))
    const live = new Set([previewForkKey('live', finishedRunStream(runs[2]))])
    expect(pickFinishedRunsToInstall(runs, retained, live, new Set(['tried'])).map(item => item.streamId)).toEqual(['unconfirmed', 'new'])
  })

  it('looks at no more than the newest MAX_FINISHED_AGENT_FORKS forks', () => {
    const runs = Array.from({ length: MAX_FINISHED_AGENT_FORKS + 3 }, (_, index) => run(`s${index}`, `l${index}`, `2026-01-${String(index + 10)}T00:00:00Z`))
    expect(pickFinishedRunsToInstall(runs, empty, new Set(), new Set())).toHaveLength(MAX_FINISHED_AGENT_FORKS)
  })

  it('installs a finished run parent-first with its mode and error state, and never replaces a captured run', () => {
    const state = installed(empty, run('s1', 'l1', '2026-01-01T00:00:00Z', { status: 'errored', operationMode: 'plan' }))
    const preview = state.byStreamId.s1
    expect(preview.entries.map(entry => entry.message?.id)).toEqual(['u', 'a'])
    expect(preview.partial).toBe(false)
    expect(preview.stream).toMatchObject({ active: false, status: 'error', operationMode: 'plan', conversationId: 'c' })
    expect(preview.stream.lineage).toMatchObject({ lineageId: 'l1', lineageIdConfirmed: true })
    expect(installed(state, run('s1', 'l1', '2026-01-01T00:00:00Z'), [message('x', 'user', null)])).toBe(state)
  })

  it('syncs once per run: fetches its rows, installs it, and does not refetch it later', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/finished')
        ? { runs: [run('s1', 'l1', '2026-01-01T00:00:00Z')] }
        : { messages: [message('a', 'assistant', 'u'), message('u', 'user', 'prior')] },
    }))
    vi.stubGlobal('fetch', fetchMock)
    let state = { agentRunPreviews: empty } as any
    const dispatch = vi.fn((action: any) => { state = { agentRunPreviews: reducer(state.agentRunPreviews, action) } })
    const attempted = new Set<string>()
    await syncFinishedAgentRuns(new Set(), attempted)(dispatch as any, () => state)
    expect(state.agentRunPreviews.byStreamId.s1.entries.map((entry: any) => entry.message.id)).toEqual(['u', 'a'])
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['http://host/api/host/runs/finished', 'http://host/api/host/runs/s1/transcript'])

    state = { agentRunPreviews: empty }
    await syncFinishedAgentRuns(new Set(), attempted)(dispatch as any, () => state)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(state.agentRunPreviews.byStreamId.s1).toBeUndefined()
  })
})
