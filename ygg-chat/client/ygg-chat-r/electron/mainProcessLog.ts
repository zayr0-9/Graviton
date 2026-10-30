import fs from 'fs'
import path from 'path'
import { format } from 'util'

/**
 * Persists main-process console output (which includes the embedded server) to
 * `<logsDir>/main-YYYY-MM-DD.log`, one file per local day. Files older than the
 * retention window are deleted at install and on each day rollover, and each day
 * is capped so a log storm cannot fill the disk. The original console still runs.
 */
export interface MainProcessLogOptions {
  logsDir: string
  retentionDays?: number
  maxBytesPerDay?: number
  now?: () => Date
}

export interface MainProcessLog {
  filePath: () => string
  flush: () => Promise<void>
  uninstall: () => void
}

const FILE_PATTERN = /^main-(\d{4})-(\d{2})-(\d{2})\.log$/
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const
type Level = (typeof LEVELS)[number]

export const DEFAULT_RETENTION_DAYS = 3
export const DEFAULT_MAX_BYTES_PER_DAY = 32 * 1024 * 1024

function dayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Deletes `main-*.log` files whose day is older than today minus `retentionDays - 1`. */
export function pruneMainProcessLogs(logsDir: string, retentionDays: number, now: Date): string[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (retentionDays - 1))
  const removed: string[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(logsDir)
  } catch {
    return removed
  }
  for (const name of entries) {
    const match = FILE_PATTERN.exec(name)
    if (!match) continue
    const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (day >= cutoff) continue
    try {
      fs.unlinkSync(path.join(logsDir, name))
      removed.push(name)
    } catch {
      // A locked or already-removed file is retried at the next rollover.
    }
  }
  return removed
}

export function installMainProcessLog(options: MainProcessLogOptions): MainProcessLog {
  const retentionDays = Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS)
  const maxBytesPerDay = options.maxBytesPerDay ?? DEFAULT_MAX_BYTES_PER_DAY
  const now = options.now ?? (() => new Date())
  fs.mkdirSync(options.logsDir, { recursive: true })

  let currentDay = ''
  let currentPath = ''
  let stream: fs.WriteStream | null = null
  let bytesWritten = 0
  let capped = false
  let writing = false

  const open = (date: Date) => {
    stream?.end()
    currentDay = dayKey(date)
    currentPath = path.join(options.logsDir, `main-${currentDay}.log`)
    pruneMainProcessLogs(options.logsDir, retentionDays, date)
    try {
      bytesWritten = fs.statSync(currentPath).size
    } catch {
      bytesWritten = 0
    }
    capped = bytesWritten >= maxBytesPerDay
    stream = fs.createWriteStream(currentPath, { flags: 'a' })
    // Disk errors must never surface as an uncaught exception in the main process.
    stream.on('error', () => { stream = null })
  }

  const write = (level: Level, args: unknown[]) => {
    // Guards against recursion if a stream error handler logs.
    if (writing) return
    writing = true
    try {
      const date = now()
      if (dayKey(date) !== currentDay) open(date)
      if (!stream || capped) return
      let line = `${date.toISOString()} [${level}] ${format(...args)}\n`
      const size = Buffer.byteLength(line)
      if (bytesWritten + size > maxBytesPerDay) {
        capped = true
        line = `${date.toISOString()} [log-cap] daily limit of ${maxBytesPerDay} bytes reached; further output dropped until tomorrow\n`
      }
      bytesWritten += Buffer.byteLength(line)
      stream.write(line)
    } catch {
      // Logging is best effort.
    } finally {
      writing = false
    }
  }

  const originals = new Map<Level, (...args: unknown[]) => void>()
  for (const level of LEVELS) {
    const original = console[level]
    originals.set(level, original)
    console[level] = (...args: unknown[]) => {
      original.apply(console, args)
      write(level, args)
    }
  }

  open(now())
  write('info', [`[MainProcessLog] pid ${process.pid} logging to ${currentPath}`])

  return {
    filePath: () => currentPath,
    flush: () => new Promise(resolve => {
      if (!stream) return resolve()
      stream.write('', () => resolve())
    }),
    uninstall: () => {
      for (const [level, original] of originals) console[level] = original
      stream?.end()
      stream = null
    },
  }
}
