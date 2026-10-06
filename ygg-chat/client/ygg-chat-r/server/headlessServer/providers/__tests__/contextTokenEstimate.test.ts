import { describe, expect, it } from 'vitest'
import {
  calculateBranchContextUsage,
  safeEstimateTokenCount,
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

describe('calculateBranchContextUsage shared meter', () => {
  const usage = (usedTokens: number) => ({
    provider: 'openai' as const, inputTokens: usedTokens, outputTokens: 0,
    cachedInputTokens: 0, reasoningTokens: 0, totalTokens: usedTokens,
    usedTokens, recordedAt: '2026-10-06T00:00:00.000Z',
  })

  it('preserves the existing meter estimate including prompts, blocks and calls', () => {
    const message = { role: 'assistant', content: 'hello', content_blocks: [{ type: 'text', content: 'hello' }], tool_calls: [{ name: 'glob' }] }
    const meter = calculateBranchContextUsage({ providerName: 'lmstudio', messages: [null, message], prompts: ['project', 'conversation'] })
    const promptTokens = safeEstimateTokenCount('project') + safeEstimateTokenCount('conversation')
    const messageTokens = safeEstimateTokenCount(message.content) + estimateContentBlocksForContext(message.content_blocks) + safeEstimateTokenCount(message.tool_calls)
    expect(meter).toMatchObject({ promptAndContextTokens: promptTokens, messageTokens, totalContextTokens: promptTokens + messageTokens, source: 'estimated' })
  })

  it('uses the latest reported snapshot rather than summing turns', () => {
    const meter = calculateBranchContextUsage({ providerName: 'OpenAI (ChatGPT)', messages: [
      { role: 'assistant', context_usage: usage(100) },
      { role: 'assistant', context_usage: usage(200) },
    ] })
    expect(meter.totalContextTokens).toBe(200)
    expect(meter.source).toBe('reported')
  })

  it('excludes old tokens and old usage after the newest compaction marker', () => {
    const summary = { role: 'system', note: '__auto_compaction_summary__', content: 'short summary' }
    const meter = calculateBranchContextUsage({ providerName: 'openaichatgpt', messages: [
      { role: 'assistant', content: 'old '.repeat(10000), context_usage: usage(90000) }, summary,
    ] })
    expect(meter.totalContextTokens).toBe(safeEstimateTokenCount(summary.content))
    expect(meter.source).toBe('estimated')
    expect(meter.openAIUsageHistory).toEqual([])
  })
})
