/**
 * Finished runs from the host, for an agents pill that did not watch them finish: a
 * detached agents window, or the main window after a reload. The host keeps metadata
 * and row IDs for its newest finished main runs (`GET /api/host/runs/finished`, memory
 * only); this installs the newest run of each recent fork into the preview store.
 */
import type { AppDispatch, RootState } from '../../store/store'
import { buildLocalApiUrl } from '../../utils/api'
import { agentRunPreviewActions, MAX_FINISHED_AGENT_FORKS, previewForkKey, type AgentRunPreviewState } from './agentRunPreviewSlice'
import type { StreamState } from './chatTypes'
import { normalizeServerMessage } from './sseProjection'
import { createEmptyStreamState } from './streamHelpers'

/** `FinishedRunSummary` from the host's run registry. */
export interface FinishedAgentRun {
  streamId: string
  conversationId: string
  lineageId: string | null
  parentId: string | null
  createdAt: string
  completedAt: string
  status: 'completed' | 'errored' | 'cancelled'
  operationMode: 'plan' | 'execute' | null
}

export function finishedRunStream(run: FinishedAgentRun): StreamState {
  return {
    ...createEmptyStreamState('branch', {
      lineageId: run.lineageId ?? undefined, lineageIdConfirmed: Boolean(run.lineageId), rootMessageId: run.parentId ?? undefined,
    }),
    conversationId: run.conversationId,
    active: false,
    status: run.status === 'errored' ? 'error' : 'completed',
    ...(run.status === 'errored' ? { error: 'Run ended with an error' } : {}),
    createdAt: run.createdAt,
    ...(run.operationMode ? { operationMode: run.operationMode } : {}),
  }
}

/**
 * Which finished runs to install: the newest run of each of the newest
 * MAX_FINISHED_AGENT_FORKS forks. Skips forks with a live run (their card shows it),
 * forks whose retained run is as new or newer, and runs already tried.
 */
export function pickFinishedRunsToInstall(
  runs: FinishedAgentRun[],
  previews: AgentRunPreviewState,
  liveForkKeys: ReadonlySet<string>,
  attempted: ReadonlySet<string>,
): FinishedAgentRun[] {
  const retainedStart = new Map<string, string>()
  for (const run of Object.values(previews.byStreamId)) {
    const key = previewForkKey(run.streamId, run.stream)
    const start = retainedStart.get(key)
    if (!start || run.stream.createdAt > start) retainedStart.set(key, run.stream.createdAt)
  }
  const seenForks = new Set<string>()
  const picked: FinishedAgentRun[] = []
  const newestFirst = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.streamId.localeCompare(a.streamId))
  for (const run of newestFirst) {
    const key = previewForkKey(run.streamId, finishedRunStream(run))
    if (seenForks.has(key) || liveForkKeys.has(key)) continue
    seenForks.add(key)
    if (seenForks.size > MAX_FINISHED_AGENT_FORKS) break
    const retained = retainedStart.get(key)
    if (attempted.has(run.streamId) || previews.byStreamId[run.streamId] || (retained && retained >= run.createdAt)) continue
    picked.push(run)
  }
  return picked
}

export async function fetchFinishedAgentRuns(signal?: AbortSignal): Promise<FinishedAgentRun[]> {
  const response = await fetch(await buildLocalApiUrl('/host/runs/finished'), { signal, cache: 'no-store' })
  if (!response.ok) return []
  const data = await response.json()
  return Array.isArray(data?.runs) ? data.runs : []
}

/**
 * One sync pass: list the host's finished runs and install those this store lacks.
 * Each run is tried once per `attempted` set, so retention can release it again without
 * the next poll reinstalling it.
 */
export const syncFinishedAgentRuns = (liveForkKeys: ReadonlySet<string>, attempted: Set<string>, signal?: AbortSignal) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const runs = await fetchFinishedAgentRuns(signal).catch(() => [])
    const picked = pickFinishedRunsToInstall(runs, getState().agentRunPreviews, liveForkKeys, attempted)
    for (const run of picked) {
      if (signal?.aborted) return
      await installFinishedAgentRuns([run], signal)(dispatch, getState)
      if (!signal?.aborted) attempted.add(run.streamId)
    }
  }

/** Fetches each run's rows and installs it. A failed fetch leaves the run uninstalled. */
export const installFinishedAgentRuns = (runs: FinishedAgentRun[], signal?: AbortSignal) =>
  async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    for (const run of runs) {
      if (signal?.aborted) return
      try {
        const response = await fetch(await buildLocalApiUrl(`/host/runs/${encodeURIComponent(run.streamId)}/transcript`), { signal, cache: 'no-store' })
        if (!response.ok) continue
        const data = await response.json()
        if (getState().agentRunPreviews.byStreamId[run.streamId]) continue
        dispatch(agentRunPreviewActions.finishedRunInstalled({
          streamId: run.streamId, stream: finishedRunStream(run),
          messages: (Array.isArray(data?.messages) ? data.messages : []).map(normalizeServerMessage),
          projectId: null, conversationTitle: null, completedAt: run.completedAt,
        }))
      } catch { /* Offline or aborted: the run stays out of the pill. */ }
    }
  }
