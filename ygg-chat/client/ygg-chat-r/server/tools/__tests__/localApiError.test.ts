import { afterEach, describe, expect, it, vi } from 'vitest'

describe('localApi error handling', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('uses the server JSON error message for non-OK responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: 'Multiple skills found' }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
        })
      )
    )

    const { localApi } = await import('../../../src/utils/api.js')

    await expect(localApi.post('/skills/install/url', { url: 'https://github.com/owner/repo' })).rejects.toMatchObject({
      message: 'Local API error (/skills/install/url): Multiple skills found',
      payload: { success: false, error: 'Multiple skills found' },
      status: 400,
    })
  })
})
