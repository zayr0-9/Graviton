// server/routes/analyticsRoutes.ts
//
// Local analytics APIs, extracted verbatim from localServer.ts
// setupServer(): /api/sync/stats and both /api/local/analytics/dashboard
// handlers. The first dashboard handler answers from the analytics
// worker; the second (registered after it) is the inline fallback and
// is only reached when the first calls next(). Registration order
// preserves that pairing.

import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { localAnalyticsWorkerClient } from '../localAnalyticsWorkerClient.js'

export interface AnalyticsRoutesDeps {
  db: Database.Database
  getCurrentDbPath: () => string | null
}

export function registerAnalyticsRoutes(app: Express, deps: AnalyticsRoutesDeps): void {
  const { db } = deps
  const getCurrentDbPath = deps.getCurrentDbPath

  // Stats endpoint
  app.get('/api/sync/stats', (_req, res) => {
    try {
      const stats = {
        projects: db!.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number },
        conversations: db!.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number },
        messages: db!.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number },
        attachments: db!.prepare('SELECT COUNT(*) as count FROM message_attachments').get() as { count: number },
      }
      res.json(stats)
    } catch (error) {
      console.error('[LocalServer] Error getting stats:', error)
      res.status(500).json({ error: 'Failed to get stats' })
    }
  })

  // Local analytics dashboard endpoint
  // Keep this route before the legacy synchronous implementation below so the
  // expensive better-sqlite3 scans/aggregations run in a worker thread instead
  // of blocking the Electron/local server event loop while LoggingPage loads.
  app.get('/api/local/analytics/dashboard', async (req, res) => {
    try {
      const currentDbPath = getCurrentDbPath()
      if (!currentDbPath) {
        res.status(503).json({ error: 'Failed to get local analytics dashboard', message: 'Local database is not initialized' })
        return
      }

      const dashboard = await localAnalyticsWorkerClient.run(currentDbPath, req.query as Record<string, unknown>)
      res.json(dashboard)
    } catch (error) {
      console.error('[LocalServer] Error getting local analytics dashboard:', error)
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: 'Failed to get local analytics dashboard', message })
    }
  })

  // Legacy synchronous implementation retained as a fallback if route order changes.
  app.get('/api/local/analytics/dashboard', (req, res) => {
    try {
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
          record.function && typeof record.function === 'object'
            ? (record.function as Record<string, unknown>).arguments
            : undefined,
        ]

        for (const candidate of candidates) {
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            return candidate as Record<string, unknown>
          }
          if (typeof candidate === 'string' && candidate.trim()) {
            try {
              const parsed = JSON.parse(candidate)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>
              }
            } catch {
              // ignore malformed tool argument JSON
            }
          }
        }

        return {}
      }

      const rangeDaysParam = Number(req.query.rangeDays)
      const rangeDays = Number.isFinite(rangeDaysParam) ? clamp(Math.trunc(rangeDaysParam), 1, 365) : 30
      const projectId =
        typeof req.query.projectId === 'string' && req.query.projectId.trim() ? req.query.projectId.trim() : null
      const conversationId =
        typeof req.query.conversationId === 'string' && req.query.conversationId.trim()
          ? req.query.conversationId.trim()
          : null
      const modelFilter = typeof req.query.model === 'string' && req.query.model.trim() ? req.query.model.trim() : null
      const toolNameFilter =
        typeof req.query.toolName === 'string' && req.query.toolName.trim() ? req.query.toolName.trim() : null
      const toolStatusFilter =
        typeof req.query.toolStatus === 'string' && req.query.toolStatus.trim() ? req.query.toolStatus.trim() : null

      const sinceMs = Date.now() - rangeDays * 24 * 60 * 60 * 1000

      const projects = db!
        .prepare('SELECT id, name, created_at, storage_mode FROM projects ORDER BY created_at ASC')
        .all() as Array<{ id: string; name: string; created_at: string; storage_mode: 'cloud' | 'local' | null }>

      const conversations = db!
        .prepare('SELECT id, project_id, title, created_at, storage_mode FROM conversations ORDER BY created_at ASC')
        .all() as Array<{
        id: string
        project_id: string | null
        title: string | null
        created_at: string
        storage_mode: 'cloud' | 'local' | null
      }>

      const messages = db!
        .prepare(
          'SELECT id, conversation_id, parent_id, role, model_name, tool_calls, content, plain_text_content, content_blocks, created_at FROM messages ORDER BY created_at ASC'
        )
        .all() as Array<{
        id: string
        conversation_id: string
        parent_id: string | null
        role: string
        model_name: string | null
        tool_calls: string | null
        content: string
        plain_text_content: string | null
        content_blocks: string | null
        created_at: string
      }>

      const providerCosts = db!
        .prepare(
          `SELECT 
             pc.id,
             pc.message_id,
             pc.prompt_tokens,
             pc.completion_tokens,
             pc.reasoning_tokens,
             pc.approx_cost,
             pc.api_credit_cost,
             pc.created_at,
             m.conversation_id,
             m.model_name
           FROM provider_cost pc
           LEFT JOIN messages m ON m.id = pc.message_id
           ORDER BY pc.created_at ASC`
        )
        .all() as Array<{
        id: string
        message_id: string
        prompt_tokens: number
        completion_tokens: number
        reasoning_tokens: number
        approx_cost: number
        api_credit_cost: number
        created_at: string
        conversation_id: string | null
        model_name: string | null
      }>

      let toolJobs: Array<{
        id: string
        tool_name: string
        status: string
        conversation_id: string | null
        created_at: string
        started_at: string | null
        completed_at: string | null
        error: string | null
      }> = []

      try {
        toolJobs = db!
          .prepare(
            'SELECT id, tool_name, status, conversation_id, created_at, started_at, completed_at, error FROM tool_jobs ORDER BY created_at ASC'
          )
          .all() as typeof toolJobs
      } catch {
        toolJobs = []
      }

      const scopedProjects = projects.filter(project => {
        if (projectId && project.id !== projectId) return false
        const created = parseTimestamp(project.created_at)
        return created === null ? false : created >= sinceMs
      })

      const scopedConversations = conversations.filter(conversation => {
        if (projectId && conversation.project_id !== projectId) return false
        if (conversationId && conversation.id !== conversationId) return false
        const created = parseTimestamp(conversation.created_at)
        return created === null ? false : created >= sinceMs
      })
      const scopedConversationIdSet = new Set(scopedConversations.map(conversation => conversation.id))

      const scopedMessages = messages.filter(message => {
        if (!scopedConversationIdSet.has(message.conversation_id)) return false
        const created = parseTimestamp(message.created_at)
        return created === null ? false : created >= sinceMs
      })

      const filteredMessages = scopedMessages.filter(message => {
        if (!modelFilter) return true
        return message.model_name === modelFilter
      })

      const scopedProviderCosts = providerCosts.filter(cost => {
        const created = parseTimestamp(cost.created_at)
        if (created === null || created < sinceMs) return false
        if (conversationId && cost.conversation_id !== conversationId) return false
        if (projectId && cost.conversation_id) {
          return scopedConversationIdSet.has(cost.conversation_id)
        }
        if (projectId && !cost.conversation_id) return false
        return true
      })

      const filteredProviderCosts = scopedProviderCosts.filter(cost => {
        if (!modelFilter) return true
        return (cost.model_name || 'unknown') === modelFilter
      })

      const requestedToolCalls = filteredMessages.flatMap(message =>
        parseToolCalls(message.tool_calls)
          .map(call => extractToolName(call))
          .filter((name): name is string => Boolean(name))
      )

      const filteredRequestedToolCalls = toolNameFilter
        ? requestedToolCalls.filter(toolName => toolName === toolNameFilter)
        : requestedToolCalls

      const batchingByTool = new Map<
        string,
        { toolName: string; batches: number; expandedCalls: number; savedCalls: number }
      >()
      const batchingDailyMap = new Map<
        string,
        { date: string; batchedCalls: number; unbatchedEquivalentCalls: number; savedCalls: number }
      >()
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
          // toolNameFilter is intentionally matched against the persisted outer tool call.
          // Nested multi_call calls are a different semantic and need a separate filter if exposed later.
          if (toolNameFilter && toolName !== toolNameFilter) continue

          const args = parseToolArgs(toolCall)
          const nestedCalls = Array.isArray(args.calls) ? args.calls.length : 0
          const edits = Array.isArray(args.edits) ? args.edits.length : 0
          const expandedCalls =
            toolName === 'multi_call' && nestedCalls > 0
              ? nestedCalls
              : toolName === 'multi_edit' && edits > 0
                ? edits
                : 1
          const saved = Math.max(0, expandedCalls - 1)

          batchedCalls += 1
          unbatchedEquivalentCalls += expandedCalls
          savedCalls += saved
          addBatchingToolStat(toolName, expandedCalls)

          const daily = batchingDailyMap.get(date) || {
            date,
            batchedCalls: 0,
            unbatchedEquivalentCalls: 0,
            savedCalls: 0,
          }
          daily.batchedCalls += 1
          daily.unbatchedEquivalentCalls += expandedCalls
          daily.savedCalls += saved
          batchingDailyMap.set(date, daily)
        }
      }

      const batchingByBatchTool = Array.from(batchingByTool.values()).sort((a, b) => a.toolName.localeCompare(b.toolName))
      const batchingDaily = Array.from(batchingDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date))

      const scopedToolJobs = toolJobs.filter(job => {
        const created = parseTimestamp(job.created_at)
        if (created === null || created < sinceMs) return false
        if (conversationId && job.conversation_id !== conversationId) return false
        if (projectId && job.conversation_id && !scopedConversationIdSet.has(job.conversation_id)) return false
        if (projectId && !job.conversation_id) return false
        if (toolNameFilter && job.tool_name !== toolNameFilter) return false
        if (toolStatusFilter && job.status !== toolStatusFilter) return false
        return true
      })

      const messageById = new Map(filteredMessages.map(message => [message.id, message]))
      const messageCostIdSet = new Set(filteredProviderCosts.map(cost => cost.message_id))

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
        if (current?.parent_id && messageById.has(current.parent_id)) {
          depth = computeDepth(current.parent_id) + 1
        }
        visiting.delete(id)
        depthMemo.set(id, depth)
        return depth
      }

      const messageDepths = filteredMessages.map(message => computeDepth(message.id))
      const maxDepth = messageDepths.length > 0 ? Math.max(...messageDepths) : 0
      const avgDepth =
        messageDepths.length > 0 ? messageDepths.reduce((sum, depth) => sum + depth, 0) / messageDepths.length : 0

      const totalApproxCost = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.approx_cost), 0)
      const totalApiCredits = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.api_credit_cost), 0)
      const totalPromptTokens = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.prompt_tokens), 0)
      const totalCompletionTokens = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.completion_tokens), 0)
      const totalReasoningTokens = filteredProviderCosts.reduce((sum, row) => sum + toNumber(row.reasoning_tokens), 0)
      const totalCharacters = filteredMessages.reduce((sum, message) => {
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

              if (blocksText) {
                messageText = `${messageText}\n${blocksText}`.trim()
              }
            }
          } catch {
            // ignore malformed content_blocks
          }
        }

        return sum + messageText.length
      }, 0)
      const estimatedTotalTokens = totalCharacters * 4

      const assistantMessageCount = filteredMessages.filter(message => message.role === 'assistant').length
      const assistantWithCost = filteredMessages.filter(
        message => message.role === 'assistant' && messageCostIdSet.has(message.id)
      ).length

      const dailyCostMap = new Map<
        string,
        {
          date: string
          approxCost: number
          apiCredits: number
          promptTokens: number
          completionTokens: number
          reasoningTokens: number
        }
      >()

      for (const row of filteredProviderCosts) {
        const key = dayKey(row.created_at)
        const existing = dailyCostMap.get(key) || {
          date: key,
          approxCost: 0,
          apiCredits: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
        }
        existing.approxCost += toNumber(row.approx_cost)
        existing.apiCredits += toNumber(row.api_credit_cost)
        existing.promptTokens += toNumber(row.prompt_tokens)
        existing.completionTokens += toNumber(row.completion_tokens)
        existing.reasoningTokens += toNumber(row.reasoning_tokens)
        dailyCostMap.set(key, existing)
      }

      const dailySpend = Array.from(dailyCostMap.values())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(row => ({
          ...row,
          approxCost: round(row.approxCost),
          apiCredits: round(row.apiCredits),
        }))

      const modelStatsMap = new Map<
        string,
        { runs: number; totalApproxCost: number; totalApiCredits: number; tokens: number }
      >()
      for (const row of filteredProviderCosts) {
        const model = row.model_name || 'unknown'
        const existing = modelStatsMap.get(model) || { runs: 0, totalApproxCost: 0, totalApiCredits: 0, tokens: 0 }
        existing.runs += 1
        existing.totalApproxCost += toNumber(row.approx_cost)
        existing.totalApiCredits += toNumber(row.api_credit_cost)
        existing.tokens +=
          toNumber(row.prompt_tokens) + toNumber(row.completion_tokens) + toNumber(row.reasoning_tokens)
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
        const toolNames = parseToolCalls(message.tool_calls)
          .map(call => extractToolName(call))
          .filter((name): name is string => Boolean(name))
        if (!acc[key]) acc[key] = {}
        for (const toolName of toolNames) {
          acc[key][toolName] = (acc[key][toolName] || 0) + 1
        }
        return acc
      }, {})

      const toolStatusCounts = scopedToolJobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.status] = (acc[job.status] || 0) + 1
        return acc
      }, {})

      const failedByTool = scopedToolJobs
        .filter(job => job.status === 'failed')
        .reduce<Record<string, number>>((acc, job) => {
          acc[job.tool_name] = (acc[job.tool_name] || 0) + 1
          return acc
        }, {})

      const topFailing = Object.entries(failedByTool)
        .map(([toolName, failures]) => ({ toolName, failures }))
        .sort((a, b) => b.failures - a.failures)
        .slice(0, 10)

      const durationValues = scopedToolJobs
        .map(job => {
          const started = parseTimestamp(job.started_at)
          const completed = parseTimestamp(job.completed_at)
          if (started === null || completed === null || completed < started) return null
          return completed - started
        })
        .filter((value): value is number => value !== null)

      const toolJobStatsMap = new Map<
        string,
        {
          toolName: string
          requested: number
          total: number
          completed: number
          failed: number
          cancelled: number
          pending: number
          running: number
          durations: number[]
        }
      >()

      const ensureToolJobStat = (toolName: string) => {
        const existing = toolJobStatsMap.get(toolName)
        if (existing) return existing
        const created = {
          toolName,
          requested: toolRequestedByName[toolName] || 0,
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          pending: 0,
          running: 0,
          durations: [] as number[],
        }
        toolJobStatsMap.set(toolName, created)
        return created
      }

      for (const toolName of Object.keys(toolRequestedByName)) {
        ensureToolJobStat(toolName)
      }

      const toolJobsDailyMap = new Map<
        string,
        { date: string; requested: number; total: number; completed: number; failed: number; cancelled: number }
      >()

      for (const [date, requestedCounts] of Object.entries(requestedToolsDailyMap)) {
        const requested = Object.values(requestedCounts).reduce((sum, count) => sum + count, 0)
        toolJobsDailyMap.set(date, {
          date,
          requested,
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        })
      }

      for (const job of scopedToolJobs) {
        const stat = ensureToolJobStat(job.tool_name)
        stat.total += 1
        if (job.status === 'completed') stat.completed += 1
        else if (job.status === 'failed') stat.failed += 1
        else if (job.status === 'cancelled') stat.cancelled += 1
        else if (job.status === 'pending') stat.pending += 1
        else if (job.status === 'running') stat.running += 1

        const started = parseTimestamp(job.started_at)
        const completed = parseTimestamp(job.completed_at)
        if (started !== null && completed !== null && completed >= started) {
          stat.durations.push(completed - started)
        }

        const date = dayKey(job.created_at)
        const daily = toolJobsDailyMap.get(date) || {
          date,
          requested: 0,
          total: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        }
        daily.total += 1
        if (job.status === 'completed') daily.completed += 1
        else if (job.status === 'failed') daily.failed += 1
        else if (job.status === 'cancelled') daily.cancelled += 1
        toolJobsDailyMap.set(date, daily)
      }

      const toolJobsByTool = Array.from(toolJobStatsMap.values())
        .map(stat => {
          const terminalTotal = stat.completed + stat.failed + stat.cancelled
          const averageDurationMs =
            stat.durations.length > 0 ? round(stat.durations.reduce((sum, value) => sum + value, 0) / stat.durations.length, 2) : null
          const failureRatePct = terminalTotal > 0 ? round((stat.failed / terminalTotal) * 100, 2) : 0

          return {
            toolName: stat.toolName,
            requested: stat.requested,
            total: stat.total,
            completed: stat.completed,
            failed: stat.failed,
            cancelled: stat.cancelled,
            pending: stat.pending,
            running: stat.running,
            averageDurationMs,
            failureRatePct,
          }
        })
        .sort((a, b) => {
          if (b.total !== a.total) return b.total - a.total
          if (b.requested !== a.requested) return b.requested - a.requested
          return a.toolName.localeCompare(b.toolName)
        })

      const toolJobsDaily = Array.from(toolJobsDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date))

      const availableModels = Array.from(
        new Set([
          ...scopedProviderCosts.map(cost => cost.model_name || 'unknown'),
          ...scopedMessages.map(message => message.model_name || 'unknown'),
        ])
      ).sort()

      const availableToolNames = Array.from(
        new Set(
          scopedMessages.flatMap(message =>
            parseToolCalls(message.tool_calls)
              .map(call => extractToolName(call))
              .filter((name): name is string => Boolean(name))
          )
        )
      ).sort()

      const burnRatePerDay = totalApiCredits / Math.max(1, rangeDays)

      res.json({
        rangeDays,
        source: 'local',
        filters: {
          applied: {
            projectId,
            conversationId,
            model: modelFilter,
            providerRunStatus: null,
            toolName: toolNameFilter,
            toolStatus: toolStatusFilter,
          },
          available: {
            models: availableModels,
            providerRunStatuses: [],
            toolNames: availableToolNames,
            toolJobStatuses: Array.from(new Set(toolJobs.map(job => job.status))).sort(),
            projects: scopedProjects.map(project => ({
              id: project.id,
              name: project.name,
              storage_mode: project.storage_mode,
            })),
            conversations: scopedConversations.map(conversation => ({
              id: conversation.id,
              title: conversation.title,
              project_id: conversation.project_id,
              storage_mode: conversation.storage_mode,
            })),
          },
        },
        summary: {
          netCreditsConsumed: round(totalApiCredits),
          totalReservedCredits: 0,
          totalRefundCredits: 0,
          totalAdjustmentCredits: 0,
          averageCreditsPerGeneration: round(totalApiCredits / Math.max(1, filteredProviderCosts.length)),
          averageCreditsPerAssistantMessage: round(totalApiCredits / Math.max(1, assistantMessageCount)),
          messagesTotal: filteredMessages.length,
          conversationsCreated: scopedConversations.length,
          projectsCreated: scopedProjects.length,
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
          burnRate: {
            creditsPerDay: round(burnRatePerDay),
            projectedDaysRemaining: null,
          },
        },
        models: {
          topByCredits: topModels,
          tokenMixByModel: topModels.map(model => ({
            model: model.model,
            prompt: model.totalTokens,
            completion: 0,
            reasoning: 0,
            samples: model.runs,
          })),
        },
        providerRuns: {
          statusCounts: {},
          quality: {
            total: 0,
            withGenerationIdPct: 0,
            withMessageLinkPct: 0,
            withConversationLinkPct: 0,
            reconciledPct: 0,
            lastReconciledAt: null,
          },
          reconcileLagMinutes: {
            avg: 0,
            p50: 0,
            p90: 0,
            max: 0,
          },
        },
        activity: {
          messagesByRole: messageCountByRole,
          messagesPerDay: Object.entries(messagesPerDay)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date)),
          branching: {
            branchPoints,
            averageDepth: round(avgDepth, 2),
            maxDepth,
          },
        },
        tools: {
          requested: {
            total: filteredRequestedToolCalls.length,
            byName: toolRequestedByName,
          },
          batching: {
            batchedCalls,
            unbatchedEquivalentCalls,
            savedCalls,
            savedCallsPct: unbatchedEquivalentCalls > 0 ? round((savedCalls / unbatchedEquivalentCalls) * 100, 2) : 0,
            cachePrefixSavingsFactorPct: round(savedCalls * 10, 2),
            byBatchTool: batchingByBatchTool,
            daily: batchingDaily,
          },
          jobs: {
            available: true,
            statusCounts: toolStatusCounts,
            total: scopedToolJobs.length,
            topFailing,
            averageDurationMs:
              durationValues.length > 0
                ? round(durationValues.reduce((sum, duration) => sum + duration, 0) / durationValues.length, 2)
                : null,
            byTool: toolJobsByTool,
            daily: toolJobsDaily,
          },
        },
        payments: {
          currentPlan: null,
          history: {
            monthlyAllocation: [],
            topups: [],
          },
          currentCreditsBalance: null,
        },
        dataQuality: {
          assistantMessagesWithCostPct:
            assistantMessageCount > 0 ? round((assistantWithCost / assistantMessageCount) * 100, 2) : 0,
          assistantMessagesTotal: assistantMessageCount,
          assistantMessagesWithCost: assistantWithCost,
        },
      })
    } catch (error) {
      console.error('[LocalServer] Error getting local analytics dashboard:', error)
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: 'Failed to get local analytics dashboard', message })
    }
  })
}
