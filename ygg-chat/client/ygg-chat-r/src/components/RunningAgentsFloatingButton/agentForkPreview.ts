import { previewForkKey, type AgentRunPreview } from '../../features/chats/agentRunPreviewSlice'
import { buildAgentPreviewRows } from './agentPreviewContent'

/** Confirmed fork identity only; unresolved runs must not merge by guessed lineage. */
export function selectForkPreviewRuns(byStreamId: Record<string, AgentRunPreview>, streamId: string): AgentRunPreview[] {
  const selected = byStreamId[streamId]
  if (!selected) return []
  const key = previewForkKey(streamId, selected.stream)
  return Object.values(byStreamId)
    .filter(run => previewForkKey(run.streamId, run.stream) === key)
    .sort((a, b) => a.stream.createdAt.localeCompare(b.stream.createdAt) || a.streamId.localeCompare(b.streamId))
}

export function buildForkPreviewRows(runs: readonly AgentRunPreview[]) {
  return runs.flatMap(run => buildAgentPreviewRows(run).map((row, index) => ({
    ...row, key: `${run.streamId}:${row.key}`, streamId: run.streamId,
    runStartedAt: run.stream.createdAt, firstInRun: index === 0,
  })))
}

// Share the fork lookup across mounted cards. Redux/Immer replaces this map on
// updates, so the WeakMap releases obsolete indexes with their state snapshots.
const forkIndexes = new WeakMap<Record<string, AgentRunPreview>, Map<string, readonly AgentRunPreview[]>>()
function getForkIndex(byStreamId: Record<string, AgentRunPreview>) {
  let index = forkIndexes.get(byStreamId)
  if (!index) {
    const groups = new Map<string, AgentRunPreview[]>()
    for (const run of Object.values(byStreamId)) {
      const key = previewForkKey(run.streamId, run.stream)
      const group = groups.get(key)
      if (group) group.push(run)
      else groups.set(key, [run])
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.stream.createdAt.localeCompare(b.stream.createdAt) || a.streamId.localeCompare(b.streamId))
    }
    index = groups
    forkIndexes.set(byStreamId, index)
  }
  return index
}

/** Keep the selected array stable when an unrelated run receives a token. */
export function createAgentPreviewRunsSelector(streamId: string, wholeFork: boolean) {
  let previous: readonly AgentRunPreview[] = []
  return (state: { agentRunPreviews: { byStreamId: Record<string, AgentRunPreview> } }): readonly AgentRunPreview[] => {
    const previews = state.agentRunPreviews.byStreamId
    const selected = previews[streamId]
    const next = !selected ? [] : wholeFork
      ? getForkIndex(previews).get(previewForkKey(streamId, selected.stream)) ?? []
      : [selected]
    if (next.length !== previous.length || next.some((run, index) => run !== previous[index])) previous = next
    return previous
  }
}

type PreviewRow = ReturnType<typeof buildAgentPreviewRows>[number]
const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0

/** Something a reader can see; empty text/thinking placeholders do not count. */
export function previewRowHasContent(row: PreviewRow): boolean {
  if (row.summarised || row.watcherCompletion || hasText(row.content)) return true
  return row.blocks.some(block => block.type === 'text' || block.type === 'thinking'
    ? hasText((block as { content?: unknown }).content)
    : true)
}

// Immer replaces a run object when it changes, so this caches until new output arrives.
const runContent = new WeakMap<AgentRunPreview, boolean>()
function runHasPreviewContent(run: AgentRunPreview): boolean {
  let cached = runContent.get(run)
  if (cached === undefined) {
    cached = buildAgentPreviewRows(run).some(previewRowHasContent)
    runContent.set(run, cached)
  }
  return cached
}

/** Mirrors the whole-fork card lookup: no retained representative means nothing to show. */
export function forkHasPreviewContent(byStreamId: Record<string, AgentRunPreview>, streamId: string): boolean {
  const selected = byStreamId[streamId]
  if (!selected) return false
  return (getForkIndex(byStreamId).get(previewForkKey(streamId, selected.stream)) ?? [selected]).some(runHasPreviewContent)
}
