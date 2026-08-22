import { describe, expect, it } from 'vitest'
import { buildCodexWebSocketRequestBody } from '../codex/codexWebsocket.js'

describe('buildCodexWebSocketRequestBody', () => {
  it('adds Responses Lite client metadata while preserving existing metadata', () => {
    const body = buildCodexWebSocketRequestBody(
      { model: 'gpt-5.6-luna', client_metadata: { existing: 'value' } },
      new Headers({ 'x-openai-internal-codex-responses-lite': 'true' })
    )

    expect(body).toMatchObject({
      type: 'response.create',
      client_metadata: {
        existing: 'value',
        ws_request_header_x_openai_internal_codex_responses_lite: 'true',
      },
    })
  })

  it('does not add Responses Lite metadata for legacy requests', () => {
    const body = buildCodexWebSocketRequestBody({ model: 'gpt-5.5', client_metadata: { existing: 'value' } }, new Headers())

    expect(body).toMatchObject({ type: 'response.create', client_metadata: { existing: 'value' } })
    expect((body.client_metadata as Record<string, unknown>).ws_request_header_x_openai_internal_codex_responses_lite).toBeUndefined()
  })
})
