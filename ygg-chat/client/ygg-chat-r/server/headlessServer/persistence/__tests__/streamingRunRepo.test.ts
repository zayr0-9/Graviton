import { describe, expect, it, vi } from 'vitest'
import { StreamingRunRepo } from '../streamingRunRepo.js'

function setup() {
  const rows = new Map<string, any>()
  const statements = {
    getStreamingRunById: { get: (id: string) => rows.get(id) },
    claimStreamingRun: { run: vi.fn((started_at: string, id: string) => Object.assign(rows.get(id), {
      status: 'running', source: 'headless', started_at, ended_at: null, duration_ms: null,
    })) },
    upsertStreamingRun: { run: vi.fn((...args: any[]) => {
      const existing = rows.get(args[0])
      rows.set(args[0], { ...existing, stream_id: args[0], status: args[7], source: args[12],
        metadata_json: args[18], started_at: existing?.started_at ?? args[19] })
    }) },
    attachStreamingRunToLineage: { run: vi.fn() },
    updateStreamingRun: { run: vi.fn((...args: any[]) => Object.assign(rows.get(args[10]), {
      status: args[0], metadata_json: args[6], ended_at: args[7], duration_ms: args[8],
    })) },
  }
  return { rows, statements, repo: new StreamingRunRepo({ statements }) }
}

describe('StreamingRunRepo terminal bookkeeping', () => {
  it('preserves provenance and first terminal status/timestamp across repeated finish', () => {
    const { repo, rows, statements } = setup()
    repo.upsert({ streamId: 'r', metadata: { runStatistics: { version: 1 } } })
    repo.finish('r', { status: 'error', metadata: { errorCode: 'provider_failed' } })
    const endedAt = rows.get('r').ended_at
    repo.finish('r', { status: 'completed' })
    expect(rows.get('r').status).toBe('error')
    expect(rows.get('r').ended_at).toBe(endedAt)
    expect(JSON.parse(rows.get('r').metadata_json)).toEqual({ runStatistics: { version: 1 }, errorCode: 'provider_failed' })
    expect(statements.updateStreamingRun.run).toHaveBeenCalledTimes(1)
  })
  it('claims renderer-first rows instead of preserving premature terminal state', () => {
    const { repo, rows, statements } = setup()
    rows.set('r', { source: 'renderer', status: 'aborted', started_at: '2000-01-01', ended_at: '2000-01-02' })
    repo.upsert({ streamId: 'r' })
    expect(statements.claimStreamingRun.run).toHaveBeenCalledTimes(1)
    expect(rows.get('r').status).toBe('running')
    expect(rows.get('r').started_at).not.toBe('2000-01-01')
    repo.finish('r', { status: 'completed' })
    expect(rows.get('r').status).toBe('completed')
  })
})

it('does not promote a zero-output cancellation parent into an assistant endpoint', () => {
  const { repo, statements } = setup()
  repo.upsert({ streamId: 'r' })
  repo.finish('r', { status: 'aborted', assistantMessageId: null, finalMessageId: 'shared-input' })
  const args = statements.updateStreamingRun.run.mock.calls[0]
  expect(args[2]).toBeNull()
  expect(args[3]).toBe('shared-input')
})
