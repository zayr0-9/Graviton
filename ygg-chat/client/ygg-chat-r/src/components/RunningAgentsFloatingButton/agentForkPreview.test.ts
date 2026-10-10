import { describe, expect, it } from 'vitest'
import { createEmptyStreamState } from '../../features/chats/streamHelpers'
import type { AgentRunPreview } from '../../features/chats/agentRunPreviewSlice'
import { buildForkPreviewRows, selectForkPreviewRuns } from './agentForkPreview'

const run = (streamId: string, createdAt: string, conversationId = 'chat', confirmed = true): AgentRunPreview => {
  const stream = { ...createEmptyStreamState('branch'), createdAt, conversationId,
    lineage: { lineageId: 'fork', lineageIdConfirmed: confirmed }, buffer: streamId }
  return { streamId, stream, projectId: null, conversationTitle: null, completedAt: null,
    entries: [{ key: 'same-key', stream }], turn: 0, liveKey: 'same-key', partial: false }
}

describe('fork transcript', () => {
  it('sorts runs oldest first independent of capture/completion order and scopes conversation', () => {
    const old = run('old', '2026-10-10T10:00:00Z')
    const newer = run('new', '2026-10-10T11:00:00Z')
    const sibling = run('sibling', '2026-10-10T09:00:00Z', 'other')
    const runs = selectForkPreviewRuns({ new: newer, sibling, old }, 'new')
    expect(runs.map(item => item.streamId)).toEqual(['old', 'new'])
    const rows = buildForkPreviewRows(runs)
    expect(rows.flatMap(row => row.blocks).filter(block => block.type === 'text').map(block => block.content)).toEqual(['old', 'new'])
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
    expect(rows.every(row => row.firstInRun)).toBe(true)
  })
  it('does not merge unconfirmed identities and handles missing selected runs', () => {
    const a = run('a', '2026-10-10', 'chat', false)
    const b = run('b', '2026-10-10', 'chat', false)
    expect(selectForkPreviewRuns({ a, b }, 'a')).toEqual([a])
    expect(selectForkPreviewRuns({ a }, 'missing')).toEqual([])
  })
})
