import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WINDOW_BYTES = 65536
const MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_FILES = 10000
const MAX_HISTORY_BYTES = 64 * 1024 * 1024

export interface ClaudeSessionInfo {
  sessionId: string
  name: string
  aliases: string[]
  cwd?: string
  createdAt: string
  updatedAt: string
  fileSize: number
  active: boolean
  source: 'claude_cli'
  // Internal only. Never return filesystem storage locations in tool metadata.
  file: string
  metadataSampled: boolean
}

export interface ClaudeHistory {
  sessionId: string
  cwd: string
  file: string
  bytes: number
}

export const normalizeSessionName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

function text(value: unknown, max = 240): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

function within(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Local-storage adapter, not an auth/config reader. Supports both JSONL-only and older indexed stores. */
export class ClaudeSessionStore {
  constructor(
    private readonly configDir: () => string = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    private readonly scanByteLimit = MAX_SCAN_BYTES
  ) {}

  private async entries(directory: string, signal?: AbortSignal, deadline = Date.now() + 10000) {
    const entries = []
    const handle = await fsp.opendir(directory)
    let incomplete = false
    try {
      while (true) {
        signal?.throwIfAborted()
        if (Date.now() > deadline) { incomplete = true; break }
        const entry = await handle.read()
        if (!entry) break
        if (entries.length >= MAX_FILES) { incomplete = true; break }
        entries.push(entry)
      }
    } finally { await handle.close() }
    return { entries, incomplete }
  }

  private async open(file: string) {
    const root = await fsp.realpath(path.join(this.configDir(), 'projects'))
    const real = await fsp.realpath(file)
    if (!within(root, real)) throw new Error('Claude session storage path escapes projects directory')
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    if (!(await handle.stat()).isFile()) { await handle.close(); throw new Error('Claude session is not a regular file') }
    return handle
  }

  async activeSessionIds(signal?: AbortSignal): Promise<Set<string>> {
    const result = new Set<string>()
    const directory = path.join(this.configDir(), 'sessions')
    let files
    try { files = await fsp.readdir(directory, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
      throw new Error('Cannot inspect Claude active-session registry; resume is unavailable')
    }
    for (const entry of files.slice(0, MAX_FILES)) {
      signal?.throwIfAborted()
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue
      try {
        const file = path.join(directory, entry.name)
        if ((await fsp.lstat(file)).size > WINDOW_BYTES) continue
        const record = JSON.parse(await fsp.readFile(file, 'utf8'))
        const pid = Number(entry.name.slice(0, -5))
        if (!Number.isSafeInteger(pid) || pid <= 0 || !CLAUDE_SESSION_ID.test(record.sessionId)) continue
        try { process.kill(pid, 0) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue
          // EPERM still means a live process: conservatively refuse a concurrent resume.
        }
        result.add(record.sessionId.toLowerCase())
      } catch { /* Malformed/stale registry entries do not identify an active session. */ }
    }
    return result
  }

  async discover(options: { sessionId?: string; signal?: AbortSignal } = {}) {
    const root = path.join(this.configDir(), 'projects')
    const sessions: ClaudeSessionInfo[] = []
    let incomplete = false
    let skippedFiles = 0
    let sampledBytes = 0
    let inspectedFiles = 0
    let projects
    const started = Date.now()
    try {
      const listing = await this.entries(root, options.signal, started + 10000)
      projects = listing.entries
      incomplete ||= listing.incomplete
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions, incomplete, skippedFiles }
      throw new Error('Cannot read Claude session projects directory')
    }
    const active = await this.activeSessionIds(options.signal)
    projects.sort((a, b) => a.name.localeCompare(b.name))
    if (projects.length > MAX_FILES) incomplete = true
    outer: for (const project of projects.slice(0, MAX_FILES)) {
      options.signal?.throwIfAborted()
      if (sampledBytes >= this.scanByteLimit || Date.now() - started > 10000) { incomplete = true; break }
      if (!project.isDirectory()) continue // Never follow storage symlinks.
      const directory = path.join(root, project.name)
      let entries
      try {
        const listing = await this.entries(directory, options.signal, started + 10000)
        entries = listing.entries
        incomplete ||= listing.incomplete
      } catch { options.signal?.throwIfAborted(); skippedFiles++; incomplete = true; continue }
      const indexed = new Map<string, Record<string, unknown>>()
      try {
        const index = await this.open(path.join(directory, 'sessions-index.json'))
        try {
          const size = (await index.stat()).size
          if (sampledBytes + size > this.scanByteLimit) { incomplete = true; break outer }
          if (size <= 2 * 1024 * 1024) {
            sampledBytes += size
            const data = JSON.parse(await index.readFile('utf8'))
            if (Array.isArray(data.entries)) for (const item of data.entries) {
              if (item && typeof item.sessionId === 'string' && CLAUDE_SESSION_ID.test(item.sessionId)) indexed.set(item.sessionId.toLowerCase(), item)
            }
          }
        } finally { await index.close() }
      } catch { /* Indexes are optional and may be stale. Never trust their fullPath or firstPrompt. */ }
      for (const entry of entries) {
        options.signal?.throwIfAborted()
        const id = entry.name.slice(0, -6)
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !CLAUDE_SESSION_ID.test(id)) continue
        if (options.sessionId && id.toLowerCase() !== options.sessionId.toLowerCase()) continue
        if (++inspectedFiles > MAX_FILES || sampledBytes + WINDOW_BYTES * 2 > this.scanByteLimit || Date.now() - started > 10000) { incomplete = true; break outer }
        const file = path.join(directory, entry.name)
        try {
          const handle = await this.open(file)
          let head: Buffer, tail: Buffer, stat
          try {
            stat = await handle.stat()
            head = Buffer.alloc(Math.min(stat.size, WINDOW_BYTES))
            await handle.read(head, 0, head.length, 0)
            const start = Math.max(head.length, stat.size - WINDOW_BYTES)
            tail = Buffer.alloc(stat.size - start)
            if (tail.length) await handle.read(tail, 0, tail.length, start)
            // A tail window may begin in the middle of JSON/UTF-8; discard that partial record.
            if (start > head.length) { const newline = tail.indexOf(10); tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1) }
          } finally { await handle.close() }
          sampledBytes += head.length + tail.length
          let cwd: string | undefined
          let title: string | undefined
          let summary: string | undefined
          let createdAt: string | undefined
          for (const line of `${head.toString('utf8')}\n${tail.toString('utf8')}`.split('\n')) {
            try {
              const record = JSON.parse(line)
              if (record.isSidechain) continue
              if (!cwd && typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) cwd = record.cwd
              if (record.type === 'relocated' && typeof record.relocatedCwd === 'string' && path.isAbsolute(record.relocatedCwd)) cwd = record.relocatedCwd
              if (record.type === 'custom-title' && (!record.sessionId || record.sessionId.toLowerCase() === id.toLowerCase())) title = text(record.customTitle)
              if (record.type === 'summary') summary = text(record.summary)
              if (!createdAt && typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))) createdAt = record.timestamp
            } catch { /* Ignore partial/malformed lines; never surface raw transcript records. */ }
          }
          // CLI 2.1.301 writes custom-title.json as well as JSONL title records.
          try {
            const sidecar = await this.open(path.join(directory, id, 'custom-title.json'))
            try {
              const size = (await sidecar.stat()).size
              if (sampledBytes + size > this.scanByteLimit) incomplete = true
              else if (size <= WINDOW_BYTES) {
                sampledBytes += size
                title = text(JSON.parse(await sidecar.readFile('utf8')).customTitle) || title
              }
            } finally { await sidecar.close() }
          } catch { /* Older CLI versions have no sidecar. */ }
          const indexedEntry = indexed.get(id.toLowerCase())
          // An index cannot override cwd extracted from the actual transcript or a newer title sidecar.
          title ||= text(indexedEntry?.customTitle)
          summary ||= text(indexedEntry?.summary)
          if (!cwd && typeof indexedEntry?.projectPath === 'string' && path.isAbsolute(indexedEntry.projectPath)) cwd = indexedEntry.projectPath
          if (cwd) { try { cwd = await fsp.realpath(cwd) } catch { cwd = path.resolve(cwd) } }
          sessions.push({ sessionId: id.toLowerCase(), name: title || summary || `Untitled ${id.slice(0, 8)}`, aliases: [...new Set([title, summary].filter((value): value is string => Boolean(value)))], cwd, createdAt: createdAt || stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString(), fileSize: stat.size, file, active: active.has(id.toLowerCase()), source: 'claude_cli', metadataSampled: stat.size > head.length + tail.length })
        } catch { skippedFiles++; incomplete = true }
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId))
    return { sessions, incomplete, skippedFiles }
  }

  /** A bounded snapshot of user/assistant text only; never expose tool payloads, thinking or credentials. */
  async readHistory(history: ClaudeHistory, signal?: AbortSignal): Promise<string> {
    if (!CLAUDE_SESSION_ID.test(history.sessionId) || path.basename(history.file).toLowerCase() !== `${history.sessionId.toLowerCase()}.jsonl`) throw new Error('Invalid Claude history reference')
    if (!Number.isSafeInteger(history.bytes) || history.bytes < 0 || history.bytes > MAX_HISTORY_BYTES) throw new Error('Claude history exceeds the 64 MiB import limit')
    if (!history.bytes) return ''
    const handle = await this.open(history.file)
    if ((await handle.stat()).size < history.bytes) { await handle.close(); throw new Error('Claude history was truncated after attachment; attach it again before reading') }
    const chunks: string[] = []
    let chars = 0
    const input = handle.createReadStream({ start: 0, end: history.bytes - 1, autoClose: false, signal })
    const lines = createInterface({ input, crlfDelay: Infinity })
    const started = Date.now()
    try {
      for await (const line of lines) {
        signal?.throwIfAborted()
        if (Date.now() - started > 10000) throw new Error('Claude history read exceeded ten seconds')
        let record
        try { record = JSON.parse(line) } catch { continue }
        if (record.isSidechain || record.isMeta || !['user', 'assistant'].includes(record.type)) continue
        const content = record.message?.content
        const body = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
        if (!body) continue
        chars += body.length
        if (chars > MAX_HISTORY_BYTES) throw new Error('Claude textual history exceeds the import limit')
        chunks.push(`[${typeof record.timestamp === 'string' ? record.timestamp : 'imported'}] ${record.type} (Claude history)\n${body}`)
      }
      return chunks.join('\n\n')
    } finally {
      lines.close()
      input.destroy()
      await handle.close()
    }
  }
}
