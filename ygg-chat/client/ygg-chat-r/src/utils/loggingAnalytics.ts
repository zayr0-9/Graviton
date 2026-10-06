import type { LoggingDashboardResponse } from '../hooks/useLoggingAnalytics'

export const formatMetric = (value: number | null | undefined, digits = 2): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—'

export const formatPercent = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${formatMetric(value, 1)}%` : '—'

export const formatDuration = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${formatMetric(value, 0)} ms`
  if (value < 60000) return `${formatMetric(value / 1000, 1)} s`
  return `${formatMetric(value / 60000, 1)} min`
}

export function rankTools<T extends { toolName: string }>(rows: T[], score: (row: T) => number, limit = 8): T[] {
  return rows.slice().sort((a, b) => score(b) - score(a) || a.toolName.localeCompare(b.toolName)).slice(0, limit)
}

// Keep the full name as row identity. Shortening is a visual axis concern only.
export const shortenLabel = (value: string, max = 22) => value.length > max ? `${value.slice(0, max - 1)}…` : value

export function toolJobRows(data: LoggingDashboardResponse) {
  const rows = new Map(data.tools.jobs.byTool.map(row => [row.toolName, { ...row }]))
  for (const [toolName, requested] of Object.entries(data.tools.requested.byName)) {
    const existing = rows.get(toolName)
    if (existing) existing.requested = requested
    else rows.set(toolName, { toolName, requested, total: 0, completed: 0, failed: 0, cancelled: 0,
      pending: 0, running: 0, averageDurationMs: null, failureRatePct: 0 })
  }
  return rankTools(Array.from(rows.values()), row => Math.max(row.total, row.requested), rows.size)
}

export function uniqueToolCount(data: LoggingDashboardResponse): number {
  return new Set([...Object.keys(data.tools.requested.byName), ...data.tools.jobs.byTool.map(row => row.toolName),
    ...(data.executions?.byTool.map(row => row.toolName) || [])]).size
}

export function usageHeadline(data: LoggingDashboardResponse): { label: string; value: number | undefined; detail: string } {
  if (data.reportedUsage && data.reportedUsage.samples > 0) {
    return { label: 'Reported token samples', value: data.reportedUsage.totalTokens,
      detail: `${formatMetric(data.reportedUsage.samples, 0)} persisted OpenAI samples · not complete run usage` }
  }
  if (data.spend.totals && data.availability?.costs !== false) {
    return { label: 'Cost-record tokens', value: data.spend.totals.promptTokens + data.spend.totals.completionTokens,
      detail: 'Input + output from cost records · coverage may be partial' }
  }
  return { label: 'Stored text tokens (est.)', value: data.summary.estimatedTotalTokens,
    detail: 'Text estimate only · not generation usage' }
}

export function activityTimeline(data: LoggingDashboardResponse) {
  const rows = new Map<string, { date: string; messages: number }>()
  for (const row of data.activity.messagesPerDay) rows.set(row.date, { ...row, messages: row.count })
  return Array.from(rows.values()).sort((a, b) => a.date.localeCompare(b.date))
}
