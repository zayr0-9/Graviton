import { describe, expect, it, vi } from 'vitest'
import { registerRunStateRoutes } from '../routes/runStateRoutes.js'

function setup() {
  const handlers = new Map<string, any>()
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path: string, handler: any) => handlers.set(`${method} ${path}`, handler)]))
  const authoritative = { stream_id: 'r', source: 'headless', status: 'error', duration_ms: 42,
    metadata_json: JSON.stringify({ runStatistics: { version: 1, invocationRecording: true } }) }
  const statements = {
    getStreamingRunById: { get: vi.fn(() => authoritative) },
    upsertStreamingRun: { run: vi.fn() }, updateStreamingRun: { run: vi.fn() },
    getStreamingRunsByConversationId: { all: vi.fn(() => [authoritative, { ...authoritative, stream_id: 'old', metadata_json: null }]) },
    getToolCountsByConversation: { all: vi.fn(() => [{ run_id: 'r', count: 3 }]) },
  }
  registerRunStateRoutes(app as any, { statements })
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
  return { handlers, statements, res }
}

describe('run-state statistics compatibility', () => {
  it('ignores renderer lifecycle writes and source spoofing for authoritative runs', () => {
    const { handlers, statements, res } = setup()
    handlers.get('post /api/streaming/runs')({ body: { stream_id: 'r', source: 'headless', status: 'running' } }, res)
    handlers.get('patch /api/streaming/runs/:streamId')({ params: { streamId: 'r' }, body: { status: 'completed' } }, res)
    expect(statements.upsertStreamingRun.run).not.toHaveBeenCalled()
    expect(statements.updateStreamingRun.run).not.toHaveBeenCalled()
    expect(res.json.mock.calls[1][0].run.status).toBe('error')
  })
  it('returns batched counts with explicit historical coverage without dropping existing fields', () => {
    const { handlers, statements, res } = setup()
    handlers.get('get /api/conversations/:conversationId/streaming-runs')({ params: { conversationId: 'c' } }, res)
    expect(statements.getToolCountsByConversation.all).toHaveBeenCalledWith('c')
    const runs = res.json.mock.calls[0][0].runs
    expect(runs[0]).toMatchObject({ duration_ms: 42, status: 'error', tool_statistics: { count: 3, coverage: 'recorded' } })
    expect(runs[1].tool_statistics.coverage).toBe('unavailable')
  })
})
