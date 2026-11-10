import fs from 'fs'
import path from 'path'
import { dayKey, DEFAULT_RETENTION_DAYS, retentionCutoff } from './mainProcessLog.js'

/**
 * `client-errors.ndjson` holds renderer telemetry and recovery records, one JSON object
 * per line with a leading ISO `ts`. It keeps the same window as the main-process log:
 * records older than today minus `retentionDays - 1` are removed at startup and on the
 * first append of each new local day. Lines without a readable timestamp cannot be
 * shown to be recent, so they are removed too.
 */
export const CLIENT_ERROR_LOG_FILENAME = 'client-errors.ndjson'

export interface ClientErrorLogOptions {
  logsDir: string
  retentionDays?: number
  now?: () => Date
}

export interface ClientErrorLog {
  filePath: () => string
  append: (content: string) => void
}

const LEADING_TS = /^\{"ts":"([^"]+)"/

function recordTime(line: string): number {
  const leading = LEADING_TS.exec(line)?.[1]
  if (leading) return Date.parse(leading)
  try {
    const ts = JSON.parse(line)?.ts
    return typeof ts === 'string' ? Date.parse(ts) : Number.NaN
  } catch {
    return Number.NaN
  }
}

/** Rewrites the log without expired records. Returns the number of records removed. */
export function pruneClientErrorLog(filePath: string, retentionDays: number, now: Date): number {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return 0
  }
  const cutoff = retentionCutoff(now, retentionDays).getTime()
  const lines = content.split('\n').filter(line => line.length > 0)
  const kept = lines.filter(line => recordTime(line) >= cutoff)
  if (kept.length === lines.length) return 0
  // Replace atomically so a crash mid-prune cannot truncate the retained records.
  const temp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temp, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8')
  fs.renameSync(temp, filePath)
  return lines.length - kept.length
}

export function createClientErrorLog(options: ClientErrorLogOptions): ClientErrorLog {
  const retentionDays = Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS)
  const now = options.now ?? (() => new Date())
  const filePath = path.join(options.logsDir, CLIENT_ERROR_LOG_FILENAME)
  let prunedDay = ''

  const ensure = () => {
    fs.mkdirSync(options.logsDir, { recursive: true })
    const date = now()
    const day = dayKey(date)
    if (day === prunedDay) return
    prunedDay = day
    try {
      pruneClientErrorLog(filePath, retentionDays, date)
    } catch {
      // Retention is retried on the next day rollover; appends must still succeed.
    }
  }

  ensure()
  return {
    filePath: () => {
      ensure()
      return filePath
    },
    append: content => {
      ensure()
      fs.appendFileSync(filePath, content, 'utf-8')
    },
  }
}
