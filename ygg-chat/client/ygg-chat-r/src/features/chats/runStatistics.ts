import { readModelThroughput, type ModelThroughput, type ConversationRunStatistics, type RunMessageAttribution } from '../../../../../shared/runStatistics'
import { parseMessageMeta } from '../../../../../shared/contextInjection'
import { extractOpenAIContextUsageFromBlocks } from '../../../../../shared/contextUsage'
import type { Message } from './chatTypes'
import { runSliceTokenPrefixes, type SliceTokenEstimate } from './runSliceTokens'

export interface RunStatisticsFooterData {
  streamId: string
  anchorMessageId: string
  status: 'completed' | 'aborted' | 'error'
  durationMs: number | null
  modelThroughput?: ModelThroughput
  tools: ConversationRunStatistics['tool_statistics']
  tokens: { total: number; covered: number; responses: number; coverage: 'estimated' | 'partial' | 'unavailable';
    breakdown?: SliceTokenEstimate; requestTotal?: number; requestCoverage?: 'reported' | 'partial' | 'unavailable' }
}

/** Run membership is server provenance, never user-role adjacency or timestamps. */
export function messageRunAttribution(message: Pick<Message, 'meta'>): RunMessageAttribution | null {
  const value = parseMessageMeta(message.meta)?.runStatistics
  if (!value || typeof value !== 'object') return null
  const attribution = value as Partial<RunMessageAttribution>
  return attribution.version === 1 && typeof attribution.streamId === 'string' &&
    (attribution.kind === 'model_response' || attribution.kind === 'terminal_error')
    ? attribution as RunMessageAttribution : null
}

export function deriveRunStatistics(
  messages: readonly Message[],
  path: readonly string[],
  runs: readonly ConversationRunStatistics[],
  conversationId: string | null,
  lineageId?: string | null
): RunStatisticsFooterData[] {
  if (!conversationId || path.length === 0) return []
  const byId = new Map(messages.filter(m => String(m.conversation_id) === conversationId).map(m => [String(m.id), m]))
  const positions = new Map(path.map((id, index) => [String(id), index]))
  const branchMessages = path.map(id => byId.get(String(id)))
  const slicePrefixes = runSliceTokenPrefixes(branchMessages)
  const members = new Map<string, Message[]>()
  for (const id of path) {
    const message = byId.get(String(id))
    if (!message) continue
    const attribution = messageRunAttribution(message)
    if (!attribution) continue
    const group = members.get(attribution.streamId) ?? []
    group.push(message)
    members.set(attribution.streamId, group)
  }
  const result: RunStatisticsFooterData[] = []
  const seenRuns = new Set<string>()
  for (const run of runs) {
    if (seenRuns.has(run.stream_id) || run.conversation_id !== conversationId || run.status === 'running' ||
        (run.stream_type !== 'primary' && run.stream_type !== 'branch')) continue
    seenRuns.add(run.stream_id)
    const owned = members.get(run.stream_id) ?? []
    // A structural notice may trail the final assistant. Prefer actual final output.
    const terminalError = owned.findLast(m => messageRunAttribution(m)?.kind === 'terminal_error')
    const endpoint = terminalError?.id ?? (run.status === 'error' ? run.final_message_id ?? run.assistant_message_id : run.assistant_message_id ?? run.final_message_id)
    if (endpoint && !positions.has(String(endpoint))) {
      // Do not show a terminated run on a path cut off before its endpoint.
      // A trailing mode/system notice can be outside the path; the assistant endpoint must still resolve.
      if (!run.assistant_message_id || !positions.has(String(run.assistant_message_id)) ||
          byId.get(String(endpoint))?.role === 'assistant') continue
    }
    const ownedEndpoint = owned.at(-1)
    let anchor = run.status === 'error' && endpoint && positions.has(String(endpoint)) &&
      byId.get(String(endpoint))?.role === 'assistant'
      ? String(endpoint)
      : run.assistant_message_id && positions.has(String(run.assistant_message_id)) &&
          byId.get(String(run.assistant_message_id))?.role === 'assistant'
        ? String(run.assistant_message_id)
        : ownedEndpoint ? String(ownedEndpoint.id) : null
    if (!anchor && endpoint && positions.has(String(endpoint))) {
      // With no output, require exact lineage identity: a shared parent alone is ambiguous.
      if (lineageId && run.lineage_id === lineageId) anchor = String(endpoint)
    }
    if (!anchor) continue
    const responses = owned.filter(m => messageRunAttribution(m)?.kind === 'model_response')
    let total = 0
    let covered = 0
    const seenUsage = new Set<string>()
    for (const response of responses) {
      const usage = extractOpenAIContextUsageFromBlocks(response.content_blocks)
      if (!usage) continue
      covered += 1
      const identity = usage.responseId ? `${usage.provider}:${usage.model ?? ''}:${usage.responseId}` : String(response.id)
      if (seenUsage.has(identity)) continue
      seenUsage.add(identity)
      total += usage.totalTokens
    }
    // Exact persisted initiating input/parent bounds the raw slice. Do not subtract usage snapshots:
    // compaction and replay make those deltas a different quantity.
    const start = positions.get(String(run.user_message_id ?? run.parent_message_id ?? ''))
    const end = positions.get(anchor)!
    const parentMessage = start == null ? undefined : branchMessages[start]
    const startInclusive = start == null || !parentMessage ? undefined : start + (parentMessage.role === 'user' ? 0 : 1)
    const slice = startInclusive == null || startInclusive > end ? undefined : {
      total: slicePrefixes[end + 1].total - slicePrefixes[startInclusive].total,
      input: slicePrefixes[end + 1].input - slicePrefixes[startInclusive].input,
      output: slicePrefixes[end + 1].output - slicePrefixes[startInclusive].output,
      user: slicePrefixes[end + 1].user - slicePrefixes[startInclusive].user,
      assistant: slicePrefixes[end + 1].assistant - slicePrefixes[startInclusive].assistant,
      tools: slicePrefixes[end + 1].tools - slicePrefixes[startInclusive].tools,
    }
    const completeAttribution = run.metadata?.runResponseCount === responses.length
    result.push({
      streamId: run.stream_id, anchorMessageId: anchor, status: run.status,
      durationMs: run.duration_ms, tools: run.tool_statistics,
      modelThroughput: run.status === 'completed' ? readModelThroughput(run.metadata?.modelThroughput) : undefined,
      tokens: { total: slice?.total ?? 0, covered, responses: responses.length, breakdown: slice,
        coverage: !slice ? 'unavailable' : completeAttribution ? 'estimated' : 'partial',
        requestTotal: total,
        requestCoverage: covered === 0 ? 'unavailable' : covered === responses.length && completeAttribution && !run.metadata?.runUsageIncomplete && run.status === 'completed' ? 'reported' : 'partial' },
    })
  }
  return result.sort((a, b) => (positions.get(a.anchorMessageId) ?? 0) - (positions.get(b.anchorMessageId) ?? 0))
}

/** Resolve filtered endpoints without relocating them to unrelated later content. */
export function placeRunFooters(
  footers: readonly RunStatisticsFooterData[], path: readonly string[], visibleIds: readonly string[]
): Map<string, RunStatisticsFooterData[]> {
  const visible = new Set(visibleIds.map(String))
  const preceding = new Map<string, string>()
  let last: string | undefined
  for (const id of path) {
    if (visible.has(String(id))) last = String(id)
    if (last) preceding.set(String(id), last)
  }
  const result = new Map<string, RunStatisticsFooterData[]>()
  for (const footer of footers) {
    const anchor = preceding.get(footer.anchorMessageId)
    if (!anchor) continue
    result.set(anchor, [...(result.get(anchor) ?? []), footer])
  }
  return result
}

const formatTokens = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)

export function formatRunStatisticsDetails(footer: RunStatisticsFooterData): string {
  const { requestTotal, requestCoverage } = footer.tokens
  const usage = requestCoverage && requestCoverage !== 'unavailable'
    ? `Request usage: ${formatTokens(requestTotal ?? 0)} tokens cumulative${requestCoverage === 'partial' ? ' (partial)' : ''}`
    : 'Request usage unavailable'
  return footer.modelThroughput
    ? `${usage} · ChatGPT throughput: reported output tokens per second of provider request time, including latency and reasoning; excludes local tools, permission waits, hooks and compaction. Not backend decoding speed.`
    : usage
}

export function formatRunStatistics(footer: RunStatisticsFooterData): string {
  const seconds = Math.max(0, Math.round((footer.durationMs ?? 0) / 1000))
  const duration = footer.durationMs == null ? 'Time unavailable' : footer.durationMs < 1000 ? '<1s'
    : footer.durationMs < 60000 ? `${Math.round(footer.durationMs / 1000)}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const tools = !footer.tools || footer.tools.coverage === 'unavailable' ? 'Tools unavailable'
    : `${footer.tools.count} tool ${footer.tools.count === 1 ? 'call' : 'calls'}${footer.tools.coverage === 'partial' ? ' (partial)' : ''}`
  const tokens = footer.tokens.coverage === 'unavailable' || !footer.tokens.breakdown ? 'Tokens unavailable'
    : `~${formatTokens(footer.tokens.breakdown.input)} ↑ · ~${formatTokens(footer.tokens.breakdown.output)} ↓${footer.tokens.coverage === 'partial' ? ' (partial)' : ''}`
  const metric = footer.modelThroughput
  const rate = metric ? `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(metric.outputTokens * 1000 / metric.requestDurationMs)} tokens/s` : null
  return [footer.status === 'aborted' ? 'Stopped' : footer.status === 'error' ? 'Failed' : null, duration, tools, tokens, rate].filter(Boolean).join(' · ')
}

/** Shared logical-row projection; footer rows never become message navigation targets. */
export function interleaveRunFooters<T extends { kind: 'message'; message: { id: string } } | { kind: 'process_group'; memberMessageIds: string[] }>(
  rows: readonly T[], footers: ReadonlyMap<string, readonly RunStatisticsFooterData[]>
): Array<{ kind: 'transcript'; row: T } | { kind: 'run_stats'; statistics: RunStatisticsFooterData }> {
  return rows.flatMap(row => {
    const endpoint = row.kind === 'message' ? row.message.id : row.memberMessageIds[row.memberMessageIds.length - 1]
    return [
      { kind: 'transcript' as const, row },
      ...(footers.get(String(endpoint)) ?? []).map(statistics => ({ kind: 'run_stats' as const, statistics })),
    ]
  })
}
