import { describe, expect, it } from 'vitest'
import {
  estimateContentBlocksForContext,
  openAIContextUsageHistory,
} from '../../../../src/features/chats/contextTokenEstimate.js'

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

describe('openAIContextUsageHistory', () => {
  it('keeps ordered branch snapshots while ignoring duplicate provider response IDs', () => {
    const usage = (responseId: string, usedTokens: number, cachedInputTokens: number) => ({
      provider: 'openai' as const,
      responseId,
      inputTokens: usedTokens,
      cachedInputTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: usedTokens,
      usedTokens,
      recordedAt: '2026-07-19T00:00:00.000Z',
    })
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', context_usage: usage('resp-1', 120, 40) },
      { role: 'assistant', context_usage: usage('resp-1', 120, 40) },
      { role: 'assistant', content_blocks: [{ type: 'openai_context_usage', usage: usage('resp-2', 200, 80) }] },
    ] as any

    expect(openAIContextUsageHistory(messages)).toEqual([usage('resp-1', 120, 40), usage('resp-2', 200, 80)])
  })
})
