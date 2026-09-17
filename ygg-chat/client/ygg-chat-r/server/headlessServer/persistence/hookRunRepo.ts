import type {
  HookRunRecord,
  HookRunStatus,
  HookRunUpdate,
} from '../../hooks/hookTypes.js'

type HookRunListOptions = {
  messageId?: string
  streamId?: string
  conversationId?: string
  limit?: number
}

type HookRunRow = {
  id: string
  conversation_id: string | null
  stream_id: string | null
  event: string
  message_id: string | null
  label: string
  configured_command: string
  executed_command: string | null
  source_file: string
  scope: 'personal' | 'project' | 'local_override'
  execution_mode: 'sync' | 'async'
  status: string
  outcome_code: string | null
  outcome_summary: string | null
  cwd: string | null
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  error_summary: string | null
  stdout_preview: string | null
  stderr_preview: string | null
  log_path: string | null
  log_fallback: number
  created_at: string
  updated_at: string
}

const COLUMNS = [
  'id',
  'conversation_id',
  'stream_id',
  'event',
  'message_id',
  'label',
  'configured_command',
  'executed_command',
  'source_file',
  'scope',
  'execution_mode',
  'status',
  'outcome_code',
  'outcome_summary',
  'cwd',
  'started_at',
  'completed_at',
  'duration_ms',
  'error_summary',
  'stdout_preview',
  'stderr_preview',
  'log_path',
  'log_fallback',
  'created_at',
  'updated_at',
] as const

const UPDATE_COLUMNS: Record<string, string> = {
  conversationId: 'conversation_id',
  streamId: 'stream_id',
  event: 'event',
  messageId: 'message_id',
  label: 'label',
  configuredCommand: 'configured_command',
  executedCommand: 'executed_command',
  sourceFile: 'source_file',
  scope: 'scope',
  executionMode: 'execution_mode',
  status: 'status',
  outcomeCode: 'outcome_code',
  outcomeSummary: 'outcome_summary',
  cwd: 'cwd',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  durationMs: 'duration_ms',
  errorSummary: 'error_summary',
  stdoutPreview: 'stdout_preview',
  stderrPreview: 'stderr_preview',
  logPath: 'log_path',
  logFallback: 'log_fallback',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}

function toRecord(row: HookRunRow | undefined): HookRunRecord | undefined {
  if (!row) return undefined

  return {
    id: row.id,
    conversationId: row.conversation_id,
    streamId: row.stream_id,
    event: row.event,
    messageId: row.message_id,
    label: row.label,
    configuredCommand: row.configured_command,
    executedCommand: row.executed_command,
    sourceFile: row.source_file,
    scope: row.scope,
    executionMode: row.execution_mode,
    status: row.status as HookRunStatus,
    outcomeCode: row.outcome_code,
    outcomeSummary: row.outcome_summary,
    cwd: row.cwd,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    errorSummary: row.error_summary,
    stdoutPreview: row.stdout_preview,
    stderrPreview: row.stderr_preview,
    logPath: row.log_path,
    logFallback: row.log_fallback === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as HookRunRecord
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 100
  return Math.min(500, Math.max(1, Math.trunc(limit)))
}

export class HookRunRepo {
  private readonly db: any

  constructor({ db }: { db: any }) {
    this.db = db
  }

  create(record: HookRunRecord): HookRunRecord {
    const value = record as any
    this.db
      .prepare(`
        INSERT INTO hook_runs (${COLUMNS.join(', ')})
        VALUES (${COLUMNS.map((column) => `@${column}`).join(', ')})
      `)
      .run({
        id: value.id,
        conversation_id: value.conversationId,
        stream_id: value.streamId ?? null,
        event: value.event,
        message_id: value.messageId ?? null,
        label: value.label ?? null,
        configured_command: value.configuredCommand ?? null,
        executed_command: value.executedCommand ?? null,
        source_file: value.sourceFile ?? null,
        scope: value.scope ?? null,
        execution_mode: value.executionMode ?? null,
        status: value.status,
        outcome_code: value.outcomeCode ?? null,
        outcome_summary: value.outcomeSummary ?? null,
        cwd: value.cwd ?? null,
        started_at: value.startedAt ?? null,
        completed_at: value.completedAt ?? null,
        duration_ms: value.durationMs ?? null,
        error_summary: value.errorSummary ?? null,
        stdout_preview: value.stdoutPreview ?? null,
        stderr_preview: value.stderrPreview ?? null,
        log_path: value.logPath ?? null,
        log_fallback: value.logFallback ? 1 : 0,
        created_at: value.createdAt,
        updated_at: value.updatedAt,
      })

    return this.getById(value.id) as HookRunRecord
  }

  update(id: string, update: HookRunUpdate): HookRunRecord | undefined {
    const value = update as Record<string, unknown>
    const assignments: string[] = []
    const parameters: Record<string, unknown> = { id }

    for (const [property, column] of Object.entries(UPDATE_COLUMNS)) {
      if (property === 'updatedAt' || !Object.prototype.hasOwnProperty.call(value, property)) continue
      assignments.push(`${column} = @${column}`)
      parameters[column] = property === 'logFallback'
        ? (value[property] ? 1 : 0)
        : value[property] === undefined ? null : value[property]
    }

    const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString()
    assignments.push('updated_at = @updated_at')
    parameters.updated_at = updatedAt

    this.db.prepare(`UPDATE hook_runs SET ${assignments.join(', ')} WHERE id = @id`).run(parameters)
    return this.getById(id)
  }

  getById(id: string): HookRunRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS.join(', ')} FROM hook_runs WHERE id = ?`)
      .get(id) as HookRunRow | undefined
    return toRecord(row)
  }

  list({ messageId, streamId, conversationId, limit }: HookRunListOptions = {}): HookRunRecord[] {
    const conditions: string[] = []
    const parameters: Record<string, unknown> = { limit: boundedLimit(limit) }

    if (messageId !== undefined) {
      conditions.push('message_id = @messageId')
      parameters.messageId = messageId
    }
    if (streamId !== undefined) {
      conditions.push('stream_id = @streamId')
      parameters.streamId = streamId
    }
    if (conversationId !== undefined) {
      conditions.push('conversation_id = @conversationId')
      parameters.conversationId = conversationId
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`
        SELECT ${COLUMNS.join(', ')}
        FROM hook_runs
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      `)
      .all(parameters) as HookRunRow[]

    return rows.map((row) => toRecord(row) as HookRunRecord)
  }

  recoverStaleRuns(): number {
    const now = new Date().toISOString()
    const result = this.db
      .prepare(`
        UPDATE hook_runs
        SET status = 'failed',
            outcome_code = COALESCE(outcome_code, 'interrupted'),
            outcome_summary = COALESCE(outcome_summary, 'Hook run interrupted before completion'),
            error_summary = COALESCE(error_summary, 'Hook run interrupted before completion'),
            completed_at = COALESCE(completed_at, @now),
            duration_ms = COALESCE(
              duration_ms,
              CASE
                WHEN started_at IS NULL THEN NULL
                ELSE MAX(0, CAST((julianday(@now) - julianday(started_at)) * 86400000 AS INTEGER))
              END
            ),
            updated_at = @now
        WHERE status IN ('scheduled', 'running')
      `)
      .run({ now })

    return result.changes
  }

  pruneOlderThan(iso: string): number {
    const result = this.db
      .prepare('DELETE FROM hook_runs WHERE created_at < ?')
      .run(iso)
    return result.changes
  }
}
