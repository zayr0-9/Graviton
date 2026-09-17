import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { HookRunRepo } from '../hookRunRepo.js'

const require = createRequire(import.meta.url)
let Database: any
try {
  const loaded = require('better-sqlite3')
  Database = loaded.default ?? loaded
  const probe = new Database(':memory:')
  probe.close()
} catch {
  Database = undefined
}

const describeWithSqlite = Database ? describe : describe.skip

const CREATE_TABLE = `
  CREATE TABLE hook_runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    stream_id TEXT,
    event TEXT NOT NULL,
    message_id TEXT,
    label TEXT NOT NULL,
    configured_command TEXT NOT NULL,
    executed_command TEXT,
    source_file TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('personal','project','local_override')),
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('sync','async')),
    status TEXT NOT NULL CHECK (status IN ('scheduled','running','succeeded','skipped','failed','timed_out')),
    outcome_code TEXT,
    outcome_summary TEXT,
    cwd TEXT,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    error_summary TEXT,
    stdout_preview TEXT,
    stderr_preview TEXT,
    log_path TEXT,
    log_fallback INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    conversationId: 'conversation-1',
    streamId: 'stream-1',
    event: 'message.sent',
    messageId: 'message-1',
    label: 'lint',
    configuredCommand: 'npm run lint',
    executedCommand: 'npm run lint -- --fix',
    sourceFile: '/workspace/.ygg/hooks.json',
    scope: 'project',
    executionMode: 'sync',
    status: 'running',
    outcomeCode: null,
    outcomeSummary: null,
    cwd: '/workspace',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: null,
    durationMs: null,
    errorSummary: null,
    stdoutPreview: null,
    stderrPreview: null,
    logPath: null,
    logFallback: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as any
}

describeWithSqlite('HookRunRepo', () => {
  let db: any
  let repo: HookRunRepo

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(CREATE_TABLE)
    repo = new HookRunRepo({ db })
  })

  afterEach(() => {
    db.close()
  })

  it('creates and reads a camelCase hook run record', () => {
    const input = record()

    expect(repo.create(input)).toEqual(input)
    expect(repo.getById(input.id)).toEqual(input)
    expect(repo.getById('missing')).toBeUndefined()
  })

  it('updates supplied fields and refreshes updatedAt', () => {
    repo.create(record())

    const updated = repo.update('run-1', {
      status: 'succeeded',
      outcomeCode: 'success',
      outcomeSummary: 'Hook completed',
      completedAt: '2025-01-01T00:00:02.000Z',
      durationMs: 2000,
      stdoutPreview: 'done',
      updatedAt: '2025-01-01T00:00:02.000Z',
    } as any)

    expect(updated).toMatchObject({
      id: 'run-1',
      status: 'succeeded',
      outcomeCode: 'success',
      outcomeSummary: 'Hook completed',
      completedAt: '2025-01-01T00:00:02.000Z',
      durationMs: 2000,
      stdoutPreview: 'done',
      updatedAt: '2025-01-01T00:00:02.000Z',
    })
    expect(updated?.configuredCommand).toBe('npm run lint')
    expect(repo.update('missing', { status: 'failed' } as any)).toBeUndefined()
  })

  it('lists newest runs and combines optional filters', () => {
    repo.create(record({ id: 'run-1', createdAt: '2025-01-01T00:00:01.000Z' }))
    repo.create(record({
      id: 'run-2',
      messageId: 'message-2',
      createdAt: '2025-01-01T00:00:02.000Z',
      updatedAt: '2025-01-01T00:00:02.000Z',
    }))
    repo.create(record({
      id: 'run-3',
      conversationId: 'conversation-2',
      streamId: 'stream-2',
      createdAt: '2025-01-01T00:00:03.000Z',
      updatedAt: '2025-01-01T00:00:03.000Z',
    }))

    expect(repo.list({}).map((item) => item.id)).toEqual(['run-3', 'run-2', 'run-1'])
    expect(repo.list({ conversationId: 'conversation-1', streamId: 'stream-1' }).map((item) => item.id))
      .toEqual(['run-2', 'run-1'])
    expect(repo.list({ messageId: 'message-2' }).map((item) => item.id)).toEqual(['run-2'])
  })

  it('bounds list limits between 1 and 500', () => {
    for (let index = 0; index < 510; index += 1) {
      const timestamp = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString()
      repo.create(record({ id: `run-${index}`, createdAt: timestamp, updatedAt: timestamp }))
    }

    expect(repo.list({ limit: 0 })).toHaveLength(1)
    expect(repo.list({ limit: 900 })).toHaveLength(500)
  })

  it('recovers running records while leaving terminal records unchanged', () => {
    repo.create(record({ id: 'running-run' }))
    repo.create(record({ id: 'completed-run', status: 'succeeded' }))

    expect(repo.recoverStaleRuns()).toBe(1)
    expect(repo.getById('running-run')).toMatchObject({
      status: 'failed',
      outcomeCode: 'interrupted',
      outcomeSummary: 'Hook run interrupted before completion',
      errorSummary: 'Hook run interrupted before completion',
    })
    expect(repo.getById('running-run')?.completedAt).toEqual(expect.any(String))
    expect(repo.getById('running-run')?.updatedAt).toEqual(expect.any(String))
    expect(repo.getById('completed-run')?.status).toBe('succeeded')
  })

  it('prunes records created before the supplied timestamp', () => {
    repo.create(record({ id: 'old', createdAt: '2025-01-01T00:00:00.000Z' }))
    repo.create(record({
      id: 'boundary',
      createdAt: '2025-02-01T00:00:00.000Z',
      updatedAt: '2025-02-01T00:00:00.000Z',
    }))

    expect(repo.pruneOlderThan('2025-02-01T00:00:00.000Z')).toBe(1)
    expect(repo.getById('old')).toBeUndefined()
    expect(repo.getById('boundary')).toBeDefined()
  })
})
