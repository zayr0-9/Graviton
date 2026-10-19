import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../utils/api', () => ({ buildLocalApiUrl: async (path: string) => `http://host/api${path}` }))
vi.mock('../../services/hostRuntimeBootstrap', () => ({ getHostRuntime: () => null }))
import { admitRun, resetAdmissionEpoch } from './runAdmissionClient'
afterEach(() => vi.unstubAllGlobals())

describe('desktop JSON admission without browser bootstrap', () => {
  it('fetches host epoch and reconciles a lost acknowledgement with the same operation ID', async () => {
    const receipt = { operationId: 'op', epoch: 'epoch', conversationId: 'c', streamId: 's', status: 'accepted', disposition: 'started' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ epoch: 'epoch' }) })
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce({ ok: true, json: async () => receipt })
    vi.stubGlobal('fetch', fetcher)
    expect(await admitRun('c', { operationId: 'op', streamId: 's', content: 'hello' }, new AbortController().signal)).toEqual(receipt)
    expect(fetcher.mock.calls[0][0]).toBe('http://host/api/host/runtime')
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ epoch: 'epoch', operationId: 'op' })
    expect(fetcher.mock.calls[2][0]).toBe('http://host/api/conversations/c/admissions/op')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

it('refreshes a stale epoch only on a new explicit attempt', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'epoch_mismatch', error: 'Host restarted' }) })
  vi.stubGlobal('fetch', fetcher)
  await expect(admitRun('c', { operationId: 'old' }, new AbortController().signal)).rejects.toThrow('Host restarted')
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ epoch: 'new' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ operationId: 'new', conversationId: 'c', streamId: 's2', status: 'accepted' }) })
  await admitRun('c', { operationId: 'new' }, new AbortController().signal)
  expect(fetcher.mock.calls[1][0]).toBe('http://host/api/host/runtime')
  expect(JSON.parse(fetcher.mock.calls[2][1].body).epoch).toBe('new')
})

it.each([404, 403, 503])('explains bootstrap HTTP %s and never submits an admission after failure', async status => {
  resetAdmissionEpoch()
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status })
  vi.stubGlobal('fetch', fetcher)
  await expect(admitRun('c', { operationId: 'not-submitted' }, new AbortController().signal)).rejects.toThrow(`HTTP ${status}`)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
