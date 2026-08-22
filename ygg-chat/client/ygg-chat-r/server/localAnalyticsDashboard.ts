import type Database from 'better-sqlite3'

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
  const ms = Date.parse(value)
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

const placeholders = (values: unknown[]) => values.map(() => '?').join(',')

const safeAll = <T>(db: Database.Database, sql: string, params: unknown[] = []): T[] => {
  try {
    return db.prepare(sql).all(...params) as T[]
  } catch {
    return []
  }
}

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

        if (blocksText) messageText = `${messageText}\n${blocksText}`.trim()
      }
    } catch {
      // ignore malformed content_blocks
    }
  }

  return messageText.length
}

export function buildLocalAnalyticsDashboard(db: Database.Database, query: QueryLike) {
  const rangeDays = getRangeDays(query)
  const projectId = getQueryString(query, 'projectId')
  const conversationId = getQueryString(query, 'conversationId')
  const modelFilter = getQueryString(query, 'model')
  const toolNameFilter = getQueryString(query, 'toolName')
  const toolStatusFilter = getQueryString(query, 'toolStatus')
  const sinceMs = Date.now() - rangeDays * 24 * 60 * 60 * 1000
  const sinceUnixSeconds = Math.floor(sinceMs / 1000)

  const projects = safeAll<ProjectRow>(
    db,
    `SELECT id, name, created_at, storage_mode FROM projects WHERE strftime('%s', created_at) >= ? ${projectId ? 'AND id = ?' : ''} ORDER BY created_at ASC`,
    projectId ? [sinceUnixSeconds, projectId] : [sinceUnixSeconds]
  )

  const conversationWhere = ["strftime('%s', created_at) >= ?"]
  const conversationParams: unknown[] = [sinceUnixSeconds]
  if (projectId) {
    conversationWhere.push('project_id = ?')
    conversationParams.push(projectId)
  }
  if (conversationId) {
    conversationWhere.push('id = ?')
    conversationParams.push(conversationId)
  }
  const scopedConversations = safeAll<ConversationRow>(
    db,
    `SELECT id, project_id, title, created_at, storage_mode FROM conversations WHERE ${conversationWhere.join(' AND ')} ORDER BY created_at ASC`,
    conversationParams
  )
  const scopedConversationIds = scopedConversations.map(conversation => conversation.id)
  const scopedConversationIdSet = new Set(scopedConversationIds)

  let messages: MessageRow[] = []
  if (scopedConversationIds.length > 0) {
    const messageWhere = [`strftime('%s', created_at) >= ?`, `conversation_id IN (${placeholders(scopedConversationIds)})`]
    const messageParams: unknown[] = [sinceUnixSeconds, ...scopedConversationIds]
    if (modelFilter) {
      messageWhere.push('model_name = ?')
      messageParams.push(modelFilter)
    }
    messages = safeAll<MessageRow>(
      db,
      `SELECT id, conversation_id, parent_id, role, model_name, tool_calls, content, plain_text_content, content_blocks, created_at
       FROM messages
       WHERE ${messageWhere.join(' AND ')}
       ORDER BY created_at ASC`,
      messageParams
    )
  }

  const providerWhere = ["strftime('%s', pc.created_at) >= ?"]
  const providerParams: unknown[] = [sinceUnixSeconds]
  if (scopedConversationIds.length > 0) {
    providerWhere.push(`m.conversation_id IN (${placeholders(scopedConversationIds)})`)
    providerParams.push(...scopedConversationIds)
  } else if (projectId || conversationId) {
    providerWhere.push('1 = 0')
  }
  if (modelFilter) {
    providerWhere.push("COALESCE(m.model_name, 'unknown') = ?")
    providerParams.push(modelFilter)
  }
  const providerCosts = safeAll<ProviderCostRow>(
    db,
    `SELECT pc.id, pc.message_id, pc.prompt_tokens, pc.completion_tokens, pc.reasoning_tokens, pc.approx_cost, pc.api_credit_cost,
            pc.created_at, m.conversation_id, m.model_name
     FROM provider_cost pc
     LEFT JOIN messages m ON m.id = pc.message_id
     WHERE ${providerWhere.join(' AND ')}
     ORDER BY pc.created_at ASC`,
    providerParams
  )

  const jobWhere = ["strftime('%s', created_at) >= ?"]
  const jobParams: unknown[] = [sinceUnixSeconds]
  if (scopedConversationIds.length > 0) {
    jobWhere.push(`conversation_id IN (${placeholders(scopedConversationIds)})`)
    jobParams.push(...scopedConversationIds)
  } else if (projectId || conversationId) {
    jobWhere.push('1 = 0')
  }
  if (toolNameFilter) {
    jobWhere.push('tool_name = ?')
    jobParams.push(toolNameFilter)
  }
  if (toolStatusFilter) {
    jobWhere.push('status = ?')
    jobParams.push(toolStatusFilter)
  }
  const toolJobs = safeAll<ToolJobRow>(
    db,
    `SELECT id, tool_name, status, conversation_id, created_at, started_at, completed_at, error
     FROM tool_jobs
     WHERE ${jobWhere.join(' AND ')}
     ORDER BY created_at ASC`,
    jobParams
  )

  const filteredMessages = messages
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
  const visiting = new Set<string>()
  const computeDepth = (id: string): number => {
    if (depthMemo.has(id)) return depthMemo.get(id) || 0
    if (visiting.has(id)) return 0
    visiting.add(id)
    const current = messageById.get(id)
    let depth = 0
    if (current?.parent_id && messageById.has(current.parent_id)) depth = computeDepth(current.parent_id) + 1
    visiting.delete(id)
    depthMemo.set(id, depth)
    return depth
  }
  const messageDepths = filteredMessages.map(message => computeDepth(message.id))
  const maxDepth = messageDepths.length > 0 ? Math.max(...messageDepths) : 0
  const avgDepth = messageDepths.length > 0 ? messageDepths.reduce((sum, depth) => sum + depth, 0) / messageDepths.length : 0

  const totalApproxCost = providerCosts.reduce((sum, row) => sum + toNumber(row.approx_cost), 0)
  const totalApiCredits = providerCosts.reduce((sum, row) => sum + toNumber(row.api_credit_cost), 0)
  const totalPromptTokens = providerCosts.reduce((sum, row) => sum + toNumber(row.prompt_tokens), 0)
  const totalCompletionTokens = providerCosts.reduce((sum, row) => sum + toNumber(row.completion_tokens), 0)
  const totalReasoningTokens = providerCosts.reduce((sum, row) => sum + toNumber(row.reasoning_tokens), 0)
  const estimatedTotalTokens = filteredMessages.reduce((sum, message) => sum + textLengthForTokenEstimate(message), 0) * 4

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

  const modelStatsMap = new Map<string, { runs: number; totalApproxCost: number; totalApiCredits: number; tokens: number }>()
  for (const row of providerCosts) {
    const model = row.model_name || 'unknown'
    const existing = modelStatsMap.get(model) || { runs: 0, totalApproxCost: 0, totalApiCredits: 0, tokens: 0 }
    existing.runs += 1
    existing.totalApproxCost += toNumber(row.approx_cost)
    existing.totalApiCredits += toNumber(row.api_credit_cost)
    existing.tokens += toNumber(row.prompt_tokens) + toNumber(row.completion_tokens) + toNumber(row.reasoning_tokens)
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
    for (const toolName of toolNames) acc[key][toolName] = (acc[key][toolName] || 0) + 1
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

  const availableModels = Array.from(new Set([...providerCosts.map(cost => cost.model_name || 'unknown'), ...messages.map(message => message.model_name || 'unknown')])).sort()
  const availableToolNames = Array.from(new Set(messages.flatMap(message => parseToolCalls(message.tool_calls).map(call => extractToolName(call)).filter((name): name is string => Boolean(name))))).sort()
  const burnRatePerDay = totalApiCredits / Math.max(1, rangeDays)

  return {
    rangeDays,
    source: 'local',
    filters: {
      applied: { projectId, conversationId, model: modelFilter, providerRunStatus: null, toolName: toolNameFilter, toolStatus: toolStatusFilter },
      available: {
        models: availableModels,
        providerRunStatuses: [],
        toolNames: availableToolNames,
        toolJobStatuses: Array.from(new Set(toolJobs.map(job => job.status))).sort(),
        projects: projects.map(project => ({ id: project.id, name: project.name, storage_mode: project.storage_mode })),
        conversations: scopedConversations.map(conversation => ({ id: conversation.id, title: conversation.title, project_id: conversation.project_id, storage_mode: conversation.storage_mode })),
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
      conversationsCreated: scopedConversations.length,
      projectsCreated: projects.length,
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
      tokenMixByModel: topModels.map(model => ({ model: model.model, prompt: model.totalTokens, completion: 0, reasoning: 0, samples: model.runs })),
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
        cachePrefixSavingsFactorPct: round(savedCalls * 10, 2),
        byBatchTool: Array.from(batchingByTool.values()).sort((a, b) => a.toolName.localeCompare(b.toolName)),
        daily: Array.from(batchingDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      },
      jobs: {
        available: true,
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
