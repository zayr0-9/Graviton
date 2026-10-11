import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { refreshRunStatistics } from './runStatisticsRefresh'
import { conversationQueryKeys } from './conversationQueryKeys'

describe('run statistics refresh', () => {
  it('coalesces duplicate terminal notifications and stops when the durable run is terminal', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(async () => {
      client.setQueryData(conversationQueryKeys.runStatistics('c'), [{ stream_id: 'r', status: 'completed' }])
    })
    const wait = vi.fn()
    await Promise.all([refreshRunStatistics(client, 'c', 'r', wait), refreshRunStatistics(client, 'c', 'r', wait)])
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
  it('bounds retries when abort acknowledgement precedes durable completion', async () => {
    const client = new QueryClient()
    client.setQueryData(conversationQueryKeys.runStatistics('c2'), [{ stream_id: 'r', status: 'running' }])
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
    const wait = vi.fn().mockResolvedValue(undefined)
    await refreshRunStatistics(client, 'c2', 'r', wait)
    expect(invalidate).toHaveBeenCalledTimes(3)
    expect(wait.mock.calls).toEqual([[300], [1200]])
  })
  it('does not propagate statistics read failures into generation', async () => {
    const client = new QueryClient()
    vi.spyOn(client, 'invalidateQueries').mockRejectedValue(new Error('offline'))
    await expect(refreshRunStatistics(client, 'c3', 'r')).resolves.toBeUndefined()
  })
})
