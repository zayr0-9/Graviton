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

export function buildForkPreviewRows(runs: AgentRunPreview[]) {
  return runs.flatMap(run => buildAgentPreviewRows(run).map((row, index) => ({
    ...row, key: `${run.streamId}:${row.key}`, streamId: run.streamId,
    runStartedAt: run.stream.createdAt, firstInRun: index === 0,
  })))
}
