import type Database from 'better-sqlite3'

/** Startup only: process death is not permission to repeat uncertain execution. */
export function reconcileHeadlessRuns(db: Database.Database, epoch: string, now = new Date().toISOString()): number {
  return db.transaction(() => {
    const rows = db.prepare("SELECT stream_id, started_at, metadata_json FROM streaming_runs WHERE status = 'running' AND source = 'headless'")
      .all() as Array<{ stream_id: string; started_at: string; metadata_json: string | null }>
    const update = db.prepare(`UPDATE streaming_runs SET status = 'aborted', end_reason = 'unknown',
      metadata_json = ?, ended_at = ?, updated_at = ?, duration_ms = ?
      WHERE stream_id = ? AND status = 'running' AND source = 'headless'`)
    for (const row of rows) {
      let metadata: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(row.metadata_json || '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
      } catch { /* Legacy malformed metadata is not a reason to retain a phantom live run. */ }
      const elapsed = Date.parse(now) - Date.parse(row.started_at)
      update.run(JSON.stringify({ ...metadata, interrupted: { epoch, reason: 'host_restart' } }),
        now, now, Number.isFinite(elapsed) ? Math.max(0, elapsed) : null, row.stream_id)
    }
    return rows.length
  })()
}
