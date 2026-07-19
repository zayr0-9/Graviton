import { describe, expect, it } from 'vitest'
import { estimateContentBlocksForContext } from '../../../../src/features/chats/contextTokenEstimate.js'

describe('estimateContentBlocksForContext image payload redaction', () => {
  it('does not estimate typed image Base64 as text tokens', () => {
    const short = [{ type: 'tool_result', content: [{ type: 'input_image', image_url: 'data:image/png;base64,aaaa' }] }]
    const long = [
      {
        type: 'tool_result',
        content: [{ type: 'input_image', image_url: `data:image/png;base64,${'a'.repeat(200_000)}` }],
      },
    ]

    expect(estimateContentBlocksForContext(long)).toBe(estimateContentBlocksForContext(short))
  })

  it('redacts legacy stringified view_image results recursively', () => {
    const short = [
      {
        type: 'tool_result',
        content: JSON.stringify({ image_url: 'data:image/png;base64,aaaa' }),
      },
    ]
    const long = [
      {
        type: 'tool_result',
        content: JSON.stringify({ image_url: `data:image/png;base64,${'a'.repeat(200_000)}` }),
      },
    ]

    expect(estimateContentBlocksForContext(long)).toBe(estimateContentBlocksForContext(short))
  })
})
