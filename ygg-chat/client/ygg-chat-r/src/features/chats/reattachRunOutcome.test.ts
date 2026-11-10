import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', () => ({ buildLocalApiUrl: async (path: string) => `http://host/api${path}` }))
import { reconcileGoneRun } from './reattachRunOutcome'
const run = { stream_id: 'old', conversation_id: 'c', source: 'headless', status: 'completed', end_reason: 'completed' }
afterEach(() => vi.unstubAllGlobals())
const reconcile = (row: object) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ run: row }))))
  return reconcileGoneRun('old', 'c', new AbortController().signal)
}
it('quietly reconciles a completed host run after replay eviction', async () => {
  expect(await reconcile(run)).toEqual({ recovered: 'completed' })
  expect(fetch).toHaveBeenCalledWith('http://host/api/streaming/runs/old', expect.objectContaining({ cache: 'no-store' }))
})
it('quietly reconciles explicit cancellation', async () => {
  expect(await reconcile({ ...run, status: 'aborted', end_reason: 'aborted' })).toEqual({ recovered: 'cancelled' })
})
it.each([
  { ...run, source: 'renderer' }, { ...run, conversation_id: 'other' },
  { ...run, stream_id: 'other' }, { ...run, status: 'running' },
])('does not infer success from unrelated/untrusted/live ledger rows', async row => {
  expect((await reconcile(row)).envelope?.code).toBe('run_expired')
})
it.each(['error', 'aborted'])('preserves genuine %s interruption notices', async status => {
  expect((await reconcile({ ...run, status, end_reason: 'interrupted' })).envelope?.code).toBe('stream_interrupted')
})
it('keeps uncertainty visible when ledger is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  expect((await reconcileGoneRun('old', 'c', new AbortController().signal)).envelope?.code).toBe('run_expired')
})

it.each([404, 500])('keeps uncertainty visible for ledger HTTP %s', async status => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })))
  expect((await reconcileGoneRun('old', 'c', new AbortController().signal)).envelope?.code).toBe('run_expired')
})
it('keeps malformed ledger responses uncertain', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json')))
  expect((await reconcileGoneRun('old', 'c', new AbortController().signal)).envelope?.code).toBe('run_expired')
})
it.each([
  { status: 'error', end_reason: 'error' },
  { status: 'aborted', end_reason: 'unknown' },
])('reports failed or host-restart-interrupted ledger outcomes', async outcome => {
  const result = await reconcile({ ...run, ...outcome })
  expect(result.recovered).toBeUndefined()
  expect(result.envelope?.code).toBe('stream_interrupted')
})
