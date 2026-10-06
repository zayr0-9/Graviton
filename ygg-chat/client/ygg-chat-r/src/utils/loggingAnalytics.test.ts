import { describe, expect, it } from 'vitest'
import type { LoggingDashboardResponse } from '../hooks/useLoggingAnalytics'
import { formatMetric, formatPercent, formatDuration, rankTools, shortenLabel, toolJobRows, uniqueToolCount, usageHeadline } from './loggingAnalytics'

const data = (overrides: Partial<LoggingDashboardResponse> = {}) => ({
  summary: { estimatedTotalTokens: 15 },
  spend: { totals: { promptTokens: 100, completionTokens: 40 } },
  tools: { requested: { total: 3, byName: { requestedOnly: 3 } }, jobs: { byTool: [
    { toolName: 'jobOnly', requested: 0, total: 5, completed: 4, failed: 1, cancelled: 0, running: 0, pending: 0, averageDurationMs: 10, failureRatePct: 20 },
  ] } },
  ...overrides,
}) as LoggingDashboardResponse

describe('logging analytics view models', () => {
  it('ranks the full population before limiting and leaves the original unchanged', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ toolName: `tool-${index}`, score: index }))
    expect(rankTools(rows, row => row.score)[0].toolName).toBe('tool-19')
    expect(rankTools(rows, row => row.score)).toHaveLength(8)
    expect(rows[0].toolName).toBe('tool-0')
  })
  it('counts the union and merges request-only tools without losing job-only tools', () => {
    expect(uniqueToolCount(data())).toBe(2)
    expect(toolJobRows(data()).map(row => row.toolName)).toEqual(['jobOnly', 'requestedOnly'])
    const executionOnly = data({ executions: { byTool: [{ toolName: 'executionOnly' }] } as LoggingDashboardResponse['executions'] })
    expect(uniqueToolCount(executionOnly)).toBe(3)
  })
  it('retains full identities even when visual labels collide', () => {
    const a = 'a-very-long-identical-prefix-one'
    const b = 'a-very-long-identical-prefix-two'
    expect(shortenLabel(a)).toBe(shortenLabel(b))
    expect(rankTools([{ toolName: a, count: 1 }, { toolName: b, count: 2 }], row => row.count).map(row => row.toolName)).toEqual([b, a])
  })
  it('distinguishes zero from absent or nonfinite values and formats elapsed time', () => {
    expect(formatMetric(0)).toBe('0')
    for (const value of [null, undefined, NaN, Infinity]) expect(formatMetric(value)).toBe('—')
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0)).toBe('0%')
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(1500)).toContain('1.5')
    expect(formatDuration(120000)).toBe('2 min')
  })
  it('prioritizes reported samples and never adds them to cost-record usage', () => {
    const reported = data({ reportedUsage: { samples: 2, totalTokens: 280 } as LoggingDashboardResponse['reportedUsage'] })
    expect(usageHeadline(reported).value).toBe(280)
    expect(usageHeadline(reported).detail).toContain('not complete run usage')
    expect(usageHeadline(data()).value).toBe(140)
    expect(usageHeadline(data({ availability: { costs: false, jobs: false, runs: false, executions: false } })).value).toBe(15)
  })
  it('uses only the current source batching population', () => {
    const cloud = data()
    expect(cloud.tools.batching).toBeUndefined()
    // The view reads data.tools.batching only, not a cached local query.
    expect(usageHeadline(cloud).label).toBe('Cost-record tokens')
  })
})
