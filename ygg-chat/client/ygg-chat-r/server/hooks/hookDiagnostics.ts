import fs from 'fs/promises'
import path from 'path'
import { getManagedHooksDirectory } from './hookStorage.js'
import type { HookRunRecord, HookRunStatus } from './hookTypes.js'

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_LOG_FILES = 3
const MAX_PREVIEW_CHARS = 4_000
const appendQueues = new Map<string, Promise<void>>()

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  [/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '$1: [redacted]'],
  [/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*)(["']?)[^\s,;}&\r\n]+\2/gi, '$1[redacted]'],
  [/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[redacted]@'],
]

export function redactHookDiagnostic(value: unknown, maxChars = MAX_PREVIEW_CHARS): string | null {
  if (value == null) return null
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 24))}…[truncated:${text.length}]`
  return text
}

async function isWritableDirectory(directory: string): Promise<boolean> {
  try {
    await fs.mkdir(directory, { recursive: true })
    await fs.access(directory, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveHookLogTarget(requestCwd?: string | null): Promise<{ logPath: string; fallback: boolean }> {
  const trimmed = typeof requestCwd === 'string' ? requestCwd.trim() : ''
  if (trimmed) {
    const directory = path.join(path.resolve(trimmed), '.ygg', 'logs')
    if (await isWritableDirectory(directory)) return { logPath: path.join(directory, 'hooks.ndjson'), fallback: false }
  }
  const directory = path.join(getManagedHooksDirectory(), 'logs')
  await fs.mkdir(directory, { recursive: true })
  return { logPath: path.join(directory, 'hooks.ndjson'), fallback: true }
}

async function rotateIfNeeded(logPath: string, incomingBytes: number): Promise<void> {
  let currentBytes = 0
  try { currentBytes = (await fs.stat(logPath)).size } catch { /* first write */ }
  if (currentBytes + incomingBytes <= MAX_LOG_BYTES) return
  await fs.rm(`${logPath}.${MAX_LOG_FILES}`, { force: true }).catch(() => undefined)
  for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
    await fs.rename(`${logPath}.${index}`, `${logPath}.${index + 1}`).catch(() => undefined)
  }
  await fs.rename(logPath, `${logPath}.1`).catch(() => undefined)
}

export interface HookLogTransition {
  runId: string
  status: HookRunStatus
  timestamp: string
  event: string
  conversationId?: string | null
  streamId?: string | null
  messageId?: string | null
  label: string
  scope: string
  executionMode: string
  configuredCommand: string
  executedCommand?: string | null
  sourceFile: string
  cwd?: string | null
  durationMs?: number | null
  outcomeCode?: string | null
  outcomeSummary?: string | null
  errorSummary?: string | null
  stdoutPreview?: string | null
  stderrPreview?: string | null
  logPath: string
  logFallback: boolean
}

export async function appendHookTransition(transition: HookLogTransition): Promise<void> {
  const safe = {
    ...transition,
    configuredCommand: redactHookDiagnostic(transition.configuredCommand, 2_000),
    executedCommand: redactHookDiagnostic(transition.executedCommand, 2_000),
    outcomeSummary: redactHookDiagnostic(transition.outcomeSummary, 1_000),
    errorSummary: redactHookDiagnostic(transition.errorSummary, 2_000),
    stdoutPreview: redactHookDiagnostic(transition.stdoutPreview),
    stderrPreview: redactHookDiagnostic(transition.stderrPreview),
  }
  const line = `${JSON.stringify(safe)}\n`
  const prior = appendQueues.get(transition.logPath) ?? Promise.resolve()
  const next = prior.then(async () => {
    await fs.mkdir(path.dirname(transition.logPath), { recursive: true })
    await rotateIfNeeded(transition.logPath, Buffer.byteLength(line))
    await fs.appendFile(transition.logPath, line, 'utf8')
  }).catch(error => {
    console.warn('[HookRunner] Failed to append durable hook log:', redactHookDiagnostic(error instanceof Error ? error.message : error, 500))
  }).finally(() => {
    if (appendQueues.get(transition.logPath) === next) appendQueues.delete(transition.logPath)
  })
  appendQueues.set(transition.logPath, next)
  await next
}

export function toSafeHookRunRecord(record: HookRunRecord): HookRunRecord {
  return {
    ...record,
    configuredCommand: redactHookDiagnostic(record.configuredCommand, 2_000) || '',
    executedCommand: redactHookDiagnostic(record.executedCommand, 2_000),
    outcomeSummary: redactHookDiagnostic(record.outcomeSummary, 1_000),
    errorSummary: redactHookDiagnostic(record.errorSummary, 2_000),
    stdoutPreview: redactHookDiagnostic(record.stdoutPreview),
    stderrPreview: redactHookDiagnostic(record.stderrPreview),
  }
}
