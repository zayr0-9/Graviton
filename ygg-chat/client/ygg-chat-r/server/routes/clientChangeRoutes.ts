import type { Express } from 'express'
import type Database from 'better-sqlite3'
import { hostEpoch } from '../hostEpoch.js'

/** One small poll for all observers; token output never enters this feed. */
export function registerClientChangeRoutes(app: Express, db: Database.Database): void {
  const bounds = db.prepare('SELECT MIN(seq) AS oldest, MAX(seq) AS latest FROM client_changes')
  const rows = db.prepare('SELECT * FROM client_changes WHERE seq > ? ORDER BY seq LIMIT 500')
  app.get('/api/host/changes', (req, res) => {
    let cursor = Number(req.query.after)
    const previousEpoch = req.query.epoch
    const current = bounds.get() as { oldest: number | null; latest: number | null }
    const latest = current.latest ?? 0
    const reset = previousEpoch !== hostEpoch || !Number.isSafeInteger(cursor) || cursor < 0 ||
      cursor > latest || (current.oldest !== null && cursor < current.oldest - 1)
    if (reset) cursor = latest
    res.setHeader('Cache-Control', 'no-store')
    const changes = reset ? [] : rows.all(cursor) as Array<{ seq: number }>
    res.json({ epoch: hostEpoch, reset, changes, cursor: changes.at(-1)?.seq ?? cursor, hasMore: (changes.at(-1)?.seq ?? cursor) < latest })
  })
}
