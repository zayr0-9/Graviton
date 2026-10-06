import type Database from 'better-sqlite3'
import { estimateTokenCount } from 'tokenx'
import { extractOpenAIContextUsageFromBlocks } from '../../../shared/contextUsage.js'
import { summarizeDurations, summarizeOutcomes } from './loggingAnalyticsMetrics.js'

type QueryLike = Record<string, unknown>

type ProjectRow = { id: string; name: string; created_at: string | null; storage_mode: 'cloud' | 'local' | null }
type ConversationRow = {
  id: string
  project_id: string | null
  title: string | null
  created_at: string | null
  storage_mode: 'cloud' | 'local' | null
}
type MessageRow = {
  id: string
  conversation_id: string
  parent_id: string | null
  role: string
  model_name: string | null
  tool_calls: string | null
  content: string | null
  plain_text_content: string | null
  content_blocks: string | null
  created_at: string | null
}
type ProviderCostRow = {
  id: string
  message_id: string
  prompt_tokens: number | string | null
  completion_tokens: number | string | null
  reasoning_tokens: number | string | null
  approx_cost: number | string | null
  api_credit_cost: number | string | null
  created_at: string | null
  conversation_id: string | null
  model_name: string | null
}
type ToolJobRow = {
  id: string
  tool_name: string
  status: string
  conversation_id: string | null
  created_at: string | null
  started_at: string | null
  completed_at: string | null
  error: string | null
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const round = (value: number, digits = 6) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const toNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}
const parseTimestamp = (value: unknown) => {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  // SQLite CURRENT_TIMESTAMP is UTC but has no zone; Date.parse otherwise
  // interprets it in the host's local timezone.
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value.trim())
    ? `${value.trim().replace(' ', 'T')}Z` : value
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}
const dayKey = (value: unknown) => {
  const ms = parseTimestamp(value)
  if (ms === null) return 'unknown'
  return new Date(ms).toISOString().slice(0, 10)
}
const parseToolCalls = (input: unknown): any[] => {
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') return [input]
  if (typeof input === 'string') {
    try {
      return parseToolCalls(JSON.parse(input))
    } catch {
      return []
    }
  }
  return []
}
const extractToolName = (toolCall: unknown): string | null => {
  if (!toolCall || typeof toolCall !== 'object') return null
  const record = toolCall as Record<string, unknown>
  const direct = typeof record.name === 'string' ? record.name : null
  const functionName =
    record.function && typeof record.function === 'object'
      ? typeof (record.function as Record<string, unknown>).name === 'string'
        ? ((record.function as Record<string, unknown>).name as string)
        : null
      : null
  const name = direct || functionName
  return name && name.trim() ? name.trim() : null
}
const parseToolArgs = (toolCall: unknown): Record<string, unknown> => {
  if (!toolCall || typeof toolCall !== 'object') return {}
  const record = toolCall as Record<string, unknown>
  const candidates = [
    record.args,
    record.arguments,
    record.input,
    record.function && typeof record.function === 'object' ? (record.function as Record<string, unknown>).arguments : undefined,
  ]

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate as Record<string, unknown>
    if (typeof candidate === 'string' && candidate.trim()) {
      try {
        const parsed = JSON.parse(candidate)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        // ignore malformed tool argument JSON
      }
    }
  }

  return {}
}

const getQueryString = (query: QueryLike, key: string): string | null => {
  const value = query[key]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() ? first.trim() : null
}

const getRangeDays = (query: QueryLike) => {
  const raw = Array.isArray(query.rangeDays) ? query.rangeDays[0] : query.rangeDays
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? clamp(Math.trunc(parsed), 1, 365) : 30
}

const readAll = <T>(db: Database.Database, sql: string, params: unknown[] = []): T[] =>
  db.prepare(sql).all(...params) as T[]

const hasTable = (db: Database.Database, table: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))

const textLengthForTokenEstimate = (message: MessageRow) => {
  let messageText = message.plain_text_content || message.content || ''

  if (message.content_blocks) {
    try {
      const blocks = JSON.parse(message.content_blocks)
      if (Array.isArray(blocks)) {
        const blocksText = blocks
          .map((block: any) => {
            if (!block || typeof block !== 'object') return ''
            if (block.type === 'text') return block.text || block.content || ''
            if (block.type === 'thinking') return block.thinking || block.content || ''
            if (block.type === 'tool_use') {
              const toolInput = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
              return `${block.name || 'tool'} ${toolInput}`
            }
            if (block.type === 'tool_result') return block.content || ''
            return block.content || block.text || block.thinking || ''
          })
          .join('\n')

        if (!messageText && blocksText) messageText = blocksText
      }
    } catch {
      // ignore malformed content_blocks
    }
  }

  return estimateTokenCount(messageText)
}

export function buildLocalAnalyticsDashboard(db: Database.Database, query: QueryLike, now = Date.now()) {
  // A coherent snapshot without moving heavy work onto the local server event loop.
  return db.transaction(() => buildDashboardSnapshot(db, query, now))()
}

function buildDashboardSnapshot(db: Database.Database, query: QueryLike, now: number) {
  const rangeDays = getRangeDays(query)
  const projectId = getQueryString(query, 'projectId')
  const conversationId = getQueryString(query, 'conversationId')
  const modelFilter = getQueryString(query, 'model')
  const toolNameFilter = getQueryString(query, 'toolName')
  const toolStatusFilter = getQueryString(query, 'toolStatus')
  const runStatusFilter = getQueryString(query, 'runStatus')
  const sinceMs = now - rangeDays * 24 * 60 * 60 * 1000
  const inRange = (value: unknown) => {
    const timestamp = parseTimestamp(value)
    return timestamp !== null && timestamp >= sinceMs && timestamp <= now
  }
  const dateScope = (column: string) => `julianday(${column}) BETWEEN julianday(?) AND julianday(?)`
  const dateParams = [new Date(sinceMs).toISOString(), new Date(now).toISOString()]
  const membership = (column: string) => [
    conversationId ? `${column} = ?` : '',
    projectId ? `${column} IN (SELECT id FROM conversations WHERE project_id = ?)` : '',
  ].filter(Boolean).join(' AND ') || '1 = 1'
  const memberParams = [conversationId, projectId].filter((value): value is string => Boolean(value))

  const projects = readAll<ProjectRow>(db, 'SELECT id, name, created_at, storage_mode FROM projects ORDER BY name')
  const conversationOptions = readAll<ConversationRow>(db,
    `SELECT id, project_id, title, created_at, storage_mode FROM conversations ${projectId ? 'WHERE project_id = ?' : ''} ORDER BY created_at`,
    projectId ? [projectId] : [])
  const scopedConversations = conversationOptions.filter(row => !conversationId || row.id === conversationId)
  const messages = readAll<MessageRow>(db,
    `SELECT id, conversation_id, parent_id, role, model_name, tool_calls, content, plain_text_content, content_blocks, created_at
     FROM messages WHERE ${dateScope('created_at')} AND ${membership('conversation_id')} ORDER BY created_at`,
    [...dateParams, ...memberParams])

  const costsAvailable = hasTable(db, 'provider_cost')
  const allProviderCosts = costsAvailable ? readAll<ProviderCostRow>(db,
    `SELECT pc.id, pc.message_id, pc.prompt_tokens, pc.completion_tokens, pc.reasoning_tokens, pc.approx_cost, pc.api_credit_cost,
            pc.created_at, m.conversation_id, m.model_name
     FROM provider_cost pc LEFT JOIN messages m ON m.id = pc.message_id
     WHERE ${dateScope('pc.created_at')} AND ${membership('m.conversation_id')} ORDER BY pc.created_at`,
    [...dateParams, ...memberParams]) : []
  const providerCosts = allProviderCosts.filter(row => !modelFilter || (row.model_name || 'unknown') === modelFilter)
  const jobsAvailable = hasTable(db, 'tool_jobs')
  // Jobs have no model/run ownership. Model selection cannot be applied honestly.
  const allToolJobs = jobsAvailable ? readAll<ToolJobRow>(db,
    `SELECT id, tool_name, status, conversation_id, created_at, started_at, completed_at
     FROM tool_jobs WHERE ${dateScope('created_at')} AND ${membership('conversation_id')} ORDER BY created_at`,
    [...dateParams, ...memberParams]) : []
  const toolJobs = allToolJobs.filter(row => (!toolNameFilter || row.tool_name === toolNameFilter) &&
    (!toolStatusFilter || row.status === toolStatusFilter))

  type RunRow = { status: string; stream_type: string; model_name: string | null; duration_ms: number | null; started_at: string }
  const runsAvailable = hasTable(db, 'streaming_runs')
  const allRuns = runsAvailable ? readAll<RunRow>(db,
    `SELECT status, stream_type, model_name, duration_ms, started_at FROM streaming_runs
     WHERE ${dateScope('started_at')} AND ${membership('conversation_id')}`,
    [...dateParams, ...memberParams]) : []
  const runs = allRuns.filter(row => (!modelFilter || (row.model_name || 'unknown') === modelFilter) &&
    (!runStatusFilter || row.status === runStatusFilter))

  type InvocationRow = { tool_name: string; status: string; parent_tool_invocation_id: string | null;
    duration_ms: number | null; started_at: string; model_name: string | null }
  const invocationsAvailable = hasTable(db, 'tool_invocations')
  const allInvocations = invocationsAvailable ? readAll<InvocationRow>(db,
    `SELECT ti.tool_name, ti.status, ti.parent_tool_invocation_id, ti.duration_ms, ti.started_at,
      ${runsAvailable ? 'COALESCE(sr.model_name, m.model_name)' : 'm.model_name'} AS model_name
     FROM tool_invocations ti LEFT JOIN messages m ON m.id = ti.assistant_message_id
     ${runsAvailable ? 'LEFT JOIN streaming_runs sr ON sr.stream_id = ti.run_id' : ''}
     WHERE ${dateScope('ti.started_at')} AND ${membership('ti.conversation_id')}`,
    [...dateParams, ...memberParams]) : []
  const invocations = allInvocations.filter(row => (!modelFilter || (row.model_name || 'unknown') === modelFilter) &&
    (!toolNameFilter || row.tool_name === toolNameFilter) && (!toolStatusFilter || row.status === toolStatusFilter))
  const roots = invocations.filter(row => !row.parent_tool_invocation_id)
  const nested = invocations.filter(row => Boolean(row.parent_tool_invocation_id))
  const invocationGroups = new Map<string, InvocationRow[]>()
  for (const row of invocations) {
    const group = invocationGroups.get(row.tool_name) || []
    group.push(row)
    invocationGroups.set(row.tool_name, group)
  }
  const executionsByTool = Array.from(invocationGroups.entries()).map(([toolName, rows]) => {
    return { toolName, ...summarizeOutcomes(rows), rootTotal: rows.filter(row => !row.parent_tool_invocation_id).length,
      nestedTotal: rows.filter(row => Boolean(row.parent_tool_invocation_id)).length }
  }).sort((a, b) => b.total - a.total || a.toolName.localeCompare(b.toolName))
  const executionDaily = new Map<string, { date: string; root: number; nested: number; failed: number }>()
  for (const row of invocations) {
    const date = dayKey(row.started_at)
    const bucket = executionDaily.get(date) || { date, root: 0, nested: 0, failed: 0 }
    if (row.parent_tool_invocation_id) bucket.nested++
    else bucket.root++
    if (row.status === 'failed') bucket.failed++
    executionDaily.set(date, bucket)
  }

  const filteredMessages = messages.filter(row => !modelFilter || (row.model_name || 'unknown') === modelFilter)
  const requestedToolCalls = filteredMessages.flatMap(message =>
    parseToolCalls(message.tool_calls)
      .map(call => extractToolName(call))
      .filter((name): name is string => Boolean(name))
  )
  const filteredRequestedToolCalls = toolNameFilter
    ? requestedToolCalls.filter(toolName => toolName === toolNameFilter)
    : requestedToolCalls

  const batchingByTool = new Map<string, { toolName: string; batches: number; expandedCalls: number; savedCalls: number }>()
  const batchingDailyMap = new Map<string, { date: string; batchedCalls: number; unbatchedEquivalentCalls: number; savedCalls: number }>()
  let batchedCalls = 0
  let unbatchedEquivalentCalls = 0
  let savedCalls = 0

  const addBatchingToolStat = (toolName: string, expandedCalls: number) => {
    if (toolName !== 'multi_call' && toolName !== 'multi_edit') return
    const existing = batchingByTool.get(toolName) || { toolName, batches: 0, expandedCalls: 0, savedCalls: 0 }
    existing.batches += 1
    existing.expandedCalls += expandedCalls
    existing.savedCalls += Math.max(0, expandedCalls - 1)
    batchingByTool.set(toolName, existing)
  }

  for (const message of filteredMessages) {
    const date = dayKey(message.created_at)
    for (const toolCall of parseToolCalls(message.tool_calls)) {
      const toolName = extractToolName(toolCall)
      if (!toolName) continue
      if (toolNameFilter && toolName !== toolNameFilter) continue

      const args = parseToolArgs(toolCall)
      const nestedCalls = Array.isArray(args.calls) ? args.calls.length : 0
      const edits = Array.isArray(args.edits) ? args.edits.length : 0
      const expandedCalls = toolName === 'multi_call' && nestedCalls > 0 ? nestedCalls : toolName === 'multi_edit' && edits > 0 ? edits : 1
      const saved = Math.max(0, expandedCalls - 1)

      batchedCalls += 1
      unbatchedEquivalentCalls += expandedCalls
      savedCalls += saved
      addBatchingToolStat(toolName, expandedCalls)

      const daily = batchingDailyMap.get(date) || { date, batchedCalls: 0, unbatchedEquivalentCalls: 0, savedCalls: 0 }
      daily.batchedCalls += 1
      daily.unbatchedEquivalentCalls += expandedCalls
      daily.savedCalls += saved
      batchingDailyMap.set(date, daily)
    }
  }

  const messageById = new Map(filteredMessages.map(message => [message.id, message]))
  const messageCostIdSet = new Set(providerCosts.map(cost => cost.message_id))
  const messageCountByRole = filteredMessages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] || 0) + 1
    return acc
  }, {})
  const messagesPerDay = filteredMessages.reduce<Record<string, number>>((acc, message) => {
    const key = dayKey(message.created_at)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})

  const childrenCountByParent = new Map<string, number>()
  for (const message of filteredMessages) {
    if (!message.parent_id) continue
    childrenCountByParent.set(message.parent_id, (childrenCountByParent.get(message.parent_id) || 0) + 1)
  }
  const branchPoints = Array.from(childrenCountByParent.values()).filter(count => count > 1).length
  const depthMemo = new Map<string, number>()
  const computeDepth = (id: string): number => {
    const path: string[] = []
    const visiting = new Set<string>()
    let current: string | null = id
    while (current && messageById.has(current) && !depthMemo.has(current)) {
      if (visiting.has(current)) {
        // Corrupt cyclic ancestry is not a meaningful depth; keep the report usable.
        for (const entry of path) depthMemo.set(entry, 0)
        return 0
      }
      visiting.add(current)
      path.push(current)
      current = messageById.get(current)?.parent_id || null
    }
    let depth = current && depthMemo.has(current) ? depthMemo.get(current)! + 1 : 0
    for (let index = path.length - 1; index >= 0; index--) depthMemo.set(path[index], depth++)
    return depthMemo.get(id) || 0
  }
  const messageDepths = filteredMessages.map(message => computeDepth(message.id))
  const maxDepth = messageDepths.reduce((max, depth) => Math.max(max, depth), 0)
  const activeConversationIds = new Set(filteredMessages.map(row => row.conversation_id))
  const avgDepth = messageDepths.length > 0 ? messageDepths.reduce((sum, depth) => sum + depth, 0) / messageDepths.length : 0

  const totalApproxCost = providerCosts.reduce((sum, row) => sum + toNumber(row.approx_cost), 0)
  const totalApiCredits = providerCosts.reduce((sum, row) => sum + toNumber(row.api_credit_cost), 0)
  const totalPromptTokens = providerCosts.reduce((sum, row) => sum + toNumber(row.prompt_tokens), 0)
  const totalCompletionTokens = providerCosts.reduce((sum, row) => sum + toNumber(row.completion_tokens), 0)
  const totalReasoningTokens = providerCosts.reduce((sum, row) => sum + toNumber(row.reasoning_tokens), 0)
  const estimatedTotalTokens = filteredMessages.reduce((sum, message) => sum + textLengthForTokenEstimate(message), 0)
  const seenResponses = new Set<string>()
  let reportedSamples = 0
  let duplicateSamples = 0
  let unidentifiedSamples = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let reportedReasoningTokens = 0
  let reportedTotalTokens = 0
  for (const message of filteredMessages.filter(row => row.role === 'assistant')) {
    const usage = extractOpenAIContextUsageFromBlocks(message.content_blocks)
    if (!usage) continue
    if (usage.responseId && seenResponses.has(usage.responseId)) { duplicateSamples++; continue }
    if (usage.responseId) seenResponses.add(usage.responseId)
    else unidentifiedSamples++
    reportedSamples++
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    cachedInputTokens += Math.min(usage.cachedInputTokens, usage.inputTokens)
    reportedReasoningTokens += usage.reasoningTokens
    reportedTotalTokens += usage.totalTokens
  }

  const assistantMessageCount = filteredMessages.filter(message => message.role === 'assistant').length
  const assistantWithCost = filteredMessages.filter(message => message.role === 'assistant' && messageCostIdSet.has(message.id)).length

  const dailyCostMap = new Map<string, { date: string; approxCost: number; apiCredits: number; promptTokens: number; completionTokens: number; reasoningTokens: number }>()
  for (const row of providerCosts) {
    const key = dayKey(row.created_at)
    const existing = dailyCostMap.get(key) || { date: key, approxCost: 0, apiCredits: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }
    existing.approxCost += toNumber(row.approx_cost)
    existing.apiCredits += toNumber(row.api_credit_cost)
    existing.promptTokens += toNumber(row.prompt_tokens)
    existing.completionTokens += toNumber(row.completion_tokens)
    existing.reasoningTokens += toNumber(row.reasoning_tokens)
    dailyCostMap.set(key, existing)
  }
  const dailySpend = Array.from(dailyCostMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({ ...row, approxCost: round(row.approxCost), apiCredits: round(row.apiCredits) }))

  const modelStatsMap = new Map<string, { runs: number; totalApproxCost: number; totalApiCredits: number; tokens: number; prompt: number; completion: number; reasoning: number }>()
  for (const row of providerCosts) {
    const model = row.model_name || 'unknown'
    const existing = modelStatsMap.get(model) || { runs: 0, totalApproxCost: 0, totalApiCredits: 0, tokens: 0, prompt: 0, completion: 0, reasoning: 0 }
    existing.runs += 1
    existing.totalApproxCost += toNumber(row.approx_cost)
    existing.totalApiCredits += toNumber(row.api_credit_cost)
    existing.prompt += toNumber(row.prompt_tokens)
    existing.completion += toNumber(row.completion_tokens)
    existing.reasoning += toNumber(row.reasoning_tokens)
    // Reasoning is a separate reported breakdown, not assumed additive to output.
    existing.tokens += toNumber(row.prompt_tokens) + toNumber(row.completion_tokens)
    modelStatsMap.set(model, existing)
  }
  const topModels = Array.from(modelStatsMap.entries())
    .map(([model, stat]) => ({
      model,
      runs: stat.runs,
      totalApproxCost: round(stat.totalApproxCost),
      totalActualCredits: round(stat.totalApiCredits),
      avgActualCredits: round(stat.totalApiCredits / Math.max(1, stat.runs)),
      totalTokens: Math.round(stat.tokens),
      prompt: stat.prompt, completion: stat.completion, reasoning: stat.reasoning,
    }))
    .sort((a, b) => b.totalActualCredits - a.totalActualCredits)

  const toolRequestedByName = filteredRequestedToolCalls.reduce<Record<string, number>>((acc, toolName) => {
    acc[toolName] = (acc[toolName] || 0) + 1
    return acc
  }, {})
  const requestedToolsDailyMap = filteredMessages.reduce<Record<string, Record<string, number>>>((acc, message) => {
    const key = dayKey(message.created_at)
    const toolNames = parseToolCalls(message.tool_calls).map(call => extractToolName(call)).filter((name): name is string => Boolean(name))
    if (!acc[key]) acc[key] = {}
    for (const toolName of toolNames) {
      if (!toolNameFilter || toolName === toolNameFilter) acc[key][toolName] = (acc[key][toolName] || 0) + 1
    }
    return acc
  }, {})

  const toolStatusCounts = toolJobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1
    return acc
  }, {})
  const failedByTool = toolJobs.filter(job => job.status === 'failed').reduce<Record<string, number>>((acc, job) => {
    acc[job.tool_name] = (acc[job.tool_name] || 0) + 1
    return acc
  }, {})
  const topFailing = Object.entries(failedByTool).map(([toolName, failures]) => ({ toolName, failures })).sort((a, b) => b.failures - a.failures).slice(0, 10)

  const durationValues = toolJobs
    .map(job => {
      const started = parseTimestamp(job.started_at)
      const completed = parseTimestamp(job.completed_at)
      if (started === null || completed === null || completed < started) return null
      return completed - started
    })
    .filter((value): value is number => value !== null)

  const toolJobStatsMap = new Map<string, { toolName: string; requested: number; total: number; completed: number; failed: number; cancelled: number; pending: number; running: number; durations: number[] }>()
  const ensureToolJobStat = (toolName: string) => {
    const existing = toolJobStatsMap.get(toolName)
    if (existing) return existing
    const created = { toolName, requested: toolRequestedByName[toolName] || 0, total: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, running: 0, durations: [] as number[] }
    toolJobStatsMap.set(toolName, created)
    return created
  }
  for (const toolName of Object.keys(toolRequestedByName)) ensureToolJobStat(toolName)

  const toolJobsDailyMap = new Map<string, { date: string; requested: number; total: number; completed: number; failed: number; cancelled: number }>()
  for (const [date, requestedCounts] of Object.entries(requestedToolsDailyMap)) {
    toolJobsDailyMap.set(date, { date, requested: Object.values(requestedCounts).reduce((sum, count) => sum + count, 0), total: 0, completed: 0, failed: 0, cancelled: 0 })
  }
  for (const job of toolJobs) {
    const stat = ensureToolJobStat(job.tool_name)
    stat.total += 1
    if (job.status === 'completed') stat.completed += 1
    else if (job.status === 'failed') stat.failed += 1
    else if (job.status === 'cancelled') stat.cancelled += 1
    else if (job.status === 'pending') stat.pending += 1
    else if (job.status === 'running') stat.running += 1

    const started = parseTimestamp(job.started_at)
    const completed = parseTimestamp(job.completed_at)
    if (started !== null && completed !== null && completed >= started) stat.durations.push(completed - started)

    const date = dayKey(job.created_at)
    const daily = toolJobsDailyMap.get(date) || { date, requested: 0, total: 0, completed: 0, failed: 0, cancelled: 0 }
    daily.total += 1
    if (job.status === 'completed') daily.completed += 1
    else if (job.status === 'failed') daily.failed += 1
    else if (job.status === 'cancelled') daily.cancelled += 1
    toolJobsDailyMap.set(date, daily)
  }

  const toolJobsByTool = Array.from(toolJobStatsMap.values())
    .map(stat => {
      const terminalTotal = stat.completed + stat.failed + stat.cancelled
      return {
        toolName: stat.toolName,
        requested: stat.requested,
        total: stat.total,
        completed: stat.completed,
        failed: stat.failed,
        cancelled: stat.cancelled,
        pending: stat.pending,
        running: stat.running,
        averageDurationMs: stat.durations.length > 0 ? round(stat.durations.reduce((sum, value) => sum + value, 0) / stat.durations.length, 2) : null,
        failureRatePct: terminalTotal > 0 ? round((stat.failed / terminalTotal) * 100, 2) : 0,
      }
    })
    .sort((a, b) => (b.total !== a.total ? b.total - a.total : b.requested !== a.requested ? b.requested - a.requested : a.toolName.localeCompare(b.toolName)))

  const availableModels = Array.from(new Set([...allProviderCosts.map(cost => cost.model_name || 'unknown'), ...messages.map(message => message.model_name || 'unknown'), ...allRuns.map(row => row.model_name || 'unknown'), ...allInvocations.map(row => row.model_name || 'unknown')])).sort()
  const availableToolNames = Array.from(new Set([...messages.flatMap(message => parseToolCalls(message.tool_calls).map(call => extractToolName(call)).filter((name): name is string => Boolean(name))), ...allToolJobs.map(row => row.tool_name), ...allInvocations.map(row => row.tool_name)])).sort()
  const burnRatePerDay = totalApiCredits / Math.max(1, rangeDays)

  return {
    rangeDays,
    source: 'local' as const,
    generatedAt: new Date(now).toISOString(),
    availability: { costs: costsAvailable, jobs: jobsAvailable, runs: runsAvailable, executions: invocationsAvailable },
    costRecords: providerCosts.length,
    localRuns: { available: runsAvailable, ...summarizeOutcomes(runs),
      main: summarizeOutcomes(runs.filter(row => ['primary', 'branch'].includes(row.stream_type))),
      subagents: summarizeOutcomes(runs.filter(row => row.stream_type === 'subagent')) },
    executions: { available: invocationsAvailable, root: summarizeOutcomes(roots), nested: summarizeOutcomes(nested),
      byTool: executionsByTool, daily: Array.from(executionDaily.values()).sort((a, b) => a.date.localeCompare(b.date)) },
    reportedUsage: { samples: reportedSamples, duplicateSamples, unidentifiedSamples, inputTokens, outputTokens,
      cachedInputTokens, reasoningTokens: reportedReasoningTokens, totalTokens: reportedTotalTokens,
      cachedInputPct: inputTokens > 0 ? cachedInputTokens / inputTokens * 100 : null,
      assistantMessages: assistantMessageCount,
      messagesWithUsage: filteredMessages.filter(row => row.role === 'assistant' && extractOpenAIContextUsageFromBlocks(row.content_blocks)).length },
    filters: {
      applied: { projectId, conversationId, model: modelFilter, providerRunStatus: null, runStatus: runStatusFilter, toolName: toolNameFilter, toolStatus: toolStatusFilter },
      available: {
        models: availableModels,
        providerRunStatuses: [],
        toolNames: availableToolNames,
        toolJobStatuses: Array.from(new Set([...allToolJobs.map(job => job.status), ...allInvocations.map(row => row.status)])).sort(),
        runStatuses: Array.from(new Set(allRuns.map(row => row.status))).sort(),
        projects: projects.map(project => ({ id: project.id, name: project.name, storage_mode: project.storage_mode })),
        conversations: conversationOptions.map(conversation => ({ id: conversation.id, title: conversation.title, project_id: conversation.project_id, storage_mode: conversation.storage_mode })),
      },
    },
    summary: {
      netCreditsConsumed: round(totalApiCredits),
      totalReservedCredits: 0,
      totalRefundCredits: 0,
      totalAdjustmentCredits: 0,
      averageCreditsPerGeneration: round(totalApiCredits / Math.max(1, providerCosts.length)),
      averageCreditsPerAssistantMessage: round(totalApiCredits / Math.max(1, assistantMessageCount)),
      messagesTotal: filteredMessages.length,
      conversationsCreated: scopedConversations.filter(row => inRange(row.created_at)).length,
      projectsCreated: projects.filter(row => (!projectId || row.id === projectId) &&
        (!conversationId || scopedConversations.some(conversation => conversation.project_id === row.id)) && inRange(row.created_at)).length,
      activeConversations: activeConversationIds.size,
      activeProjects: new Set(scopedConversations.filter(row => activeConversationIds.has(row.id))
        .map(row => row.project_id).filter(Boolean)).size,
      activeDays: Object.keys(messagesPerDay).length,
      estimatedTotalTokens,
    },
    spend: {
      totals: {
        approxCostUsd: round(totalApproxCost),
        apiCredits: round(totalApiCredits),
        promptTokens: Math.round(totalPromptTokens),
        completionTokens: Math.round(totalCompletionTokens),
        reasoningTokens: Math.round(totalReasoningTokens),
      },
      daily: dailySpend,
      balanceTrend: [],
      burnRate: { creditsPerDay: round(burnRatePerDay), projectedDaysRemaining: null },
    },
    models: {
      topByCredits: topModels,
      tokenMixByModel: topModels.map(model => ({ model: model.model, prompt: model.prompt, completion: model.completion, reasoning: model.reasoning, samples: model.runs })),
    },
    providerRuns: {
      statusCounts: {},
      quality: { total: 0, withGenerationIdPct: 0, withMessageLinkPct: 0, withConversationLinkPct: 0, reconciledPct: 0, lastReconciledAt: null },
      reconcileLagMinutes: { avg: 0, p50: 0, p90: 0, max: 0 },
    },
    activity: {
      messagesByRole: messageCountByRole,
      messagesPerDay: Object.entries(messagesPerDay).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
      branching: { branchPoints, averageDepth: round(avgDepth, 2), maxDepth },
    },
    tools: {
      requested: { total: filteredRequestedToolCalls.length, byName: toolRequestedByName },
      batching: {
        batchedCalls,
        unbatchedEquivalentCalls,
        savedCalls,
        savedCallsPct: unbatchedEquivalentCalls > 0 ? round((savedCalls / unbatchedEquivalentCalls) * 100, 2) : 0,
        // Legacy compatibility field; cache savings are not inferred from batching.
        cachePrefixSavingsFactorPct: 0,
        byBatchTool: Array.from(batchingByTool.values()).sort((a, b) => a.toolName.localeCompare(b.toolName)),
        daily: Array.from(batchingDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      },
      jobs: {
        available: jobsAvailable,
        statusCounts: toolStatusCounts,
        total: toolJobs.length,
        topFailing,
        averageDurationMs: durationValues.length > 0 ? round(durationValues.reduce((sum, duration) => sum + duration, 0) / durationValues.length, 2) : null,
        byTool: toolJobsByTool,
        daily: Array.from(toolJobsDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      },
    },
    payments: { currentPlan: null, history: { monthlyAllocation: [], topups: [] }, currentCreditsBalance: null },
    dataQuality: {
      assistantMessagesWithCostPct: assistantMessageCount > 0 ? round((assistantWithCost / assistantMessageCount) * 100, 2) : 0,
      assistantMessagesTotal: assistantMessageCount,
      assistantMessagesWithCost: assistantWithCost,
    },
  }
}
