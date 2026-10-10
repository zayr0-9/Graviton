export function summarizeDurations(rows: Array<{ status: string; duration_ms: number | null }>) {
  const values = rows.filter(row => row.status !== 'running' && typeof row.duration_ms === 'number' &&
    Number.isFinite(row.duration_ms) && row.duration_ms >= 0).map(row => row.duration_ms!).sort((a, b) => a - b)
  const percentile = (fraction: number) => values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null
  return { samples: values.length, averageMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50Ms: percentile(0.5), p90Ms: percentile(0.9) }
}

export function summarizeOutcomes(rows: Array<{ status: string; duration_ms: number | null }>) {
  const statusCounts: Record<string, number> = {}
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1
  const terminal = rows.filter(row => ['completed', 'failed', 'error', 'aborted', 'cancelled'].includes(row.status)).length
  return { total: rows.length, statusCounts, terminalTotal: terminal,
    failureRatePct: terminal ? ((statusCounts.failed || 0) + (statusCounts.error || 0)) / terminal * 100 : null,
    duration: summarizeDurations(rows) }
}
