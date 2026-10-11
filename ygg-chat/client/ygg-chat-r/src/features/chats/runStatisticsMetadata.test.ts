import { describe, expect, it } from 'vitest'
import { mergeLocalRunMetadata, mergeLocalUsageBlocks } from '../../../../../shared/runStatisticsMetadata'

const localMeta = JSON.stringify({ runStatistics: { version: 1, streamId: 'r', kind: 'model_response' }, kind: 'private-local-kind' })
const usage = [{ type: 'openai_context_usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } }]

describe('local run metadata enrichment', () => {
  it('retains run attribution while preserving cloud notice kind and not copying unrelated local metadata', () => {
    expect(mergeLocalRunMetadata({ kind: 'watcher_completion', files: ['a'] }, localMeta)).toEqual({
      kind: 'watcher_completion', files: ['a'], runStatistics: { version: 1, streamId: 'r', kind: 'model_response' },
    })
    expect(mergeLocalRunMetadata(null, null)).toBeNull()
  })
  it('preserves reported usage once on existing cloud block responses', () => {
    const remote = [{ type: 'text', content: 'hello' }]
    expect(mergeLocalUsageBlocks(remote, JSON.stringify(usage))).toHaveLength(2)
    expect(mergeLocalUsageBlocks(usage, usage)).toBe(usage)
    expect(mergeLocalUsageBlocks(null, usage)).toBeNull()
  })
})
