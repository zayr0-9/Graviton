import Database from 'better-sqlite3'
import { parentPort } from 'worker_threads'
import { buildLocalAnalyticsDashboard } from './localAnalyticsDashboard.js'

type AnalyticsWorkerRequest = {
  id: string
  dbPath: string
  query: Record<string, unknown>
}

if (!parentPort) {
  throw new Error('localAnalyticsWorker must be run as a worker thread')
}

parentPort.on('message', (request: AnalyticsWorkerRequest) => {
  let db: Database.Database | null = null

  try {
    db = new Database(request.dbPath, { readonly: true, fileMustExist: true })
    db.pragma('query_only = ON')
    const data = buildLocalAnalyticsDashboard(db, request.query || {})
    parentPort!.postMessage({ id: request.id, ok: true, data })
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors in worker response path
    }
  }
})
