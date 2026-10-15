import { describe, expect, it } from 'vitest'
import { getCompactionPlaceholder, getTreeMessageText, isHiddenCompactionMessage, SUMMARY_PLACEHOLDER } from './summaryPresentation'
import { buildConversationTree, buildPathToConversationMessage } from './conversationTree'
import type { Message } from './chatTypes'

describe('compaction display projection', () => {
  it.each([
    [{ kind: 'compaction_summary', state: 'committed' }, 'assistant', SUMMARY_PLACEHOLDER],
    [{ compactionPhase: 'summarising' }, 'assistant', 'Compaction response'],
    [{ kind: 'compaction_instruction' }, 'user', 'Compaction requested'],
    [{ kind: 'compaction_resume' }, 'user', 'Resuming after compaction'],
  ] as const)('uses safe presentation for %j without changing history', (meta, role, label) => {
    for (const storedMeta of [meta, JSON.stringify(meta)]) {
      const row = { id: 'compact', parent_id: 'root', role, meta: storedMeta,
        content: 'SECRET_SUMMARY', content_blocks: [{ type: 'text', content: 'SECRET_BLOCK' }] } as unknown as Message
      const rows = [{ id: 'root', role: 'user', content: 'Task' }, row,
        { id: 'next', parent_id: 'compact', role: 'assistant', content: 'Resumed' }] as Message[]
      expect(getCompactionPlaceholder(row)).toBe(label)
      expect(getTreeMessageText(row)).toBe(label)
      expect(JSON.stringify(buildConversationTree(rows))).not.toContain('SECRET_')
      expect(buildPathToConversationMessage(rows, 'next')).toEqual(['root', 'compact', 'next'])
      expect(row.content).toBe('SECRET_SUMMARY')
      expect(row.content_blocks?.[0]).toMatchObject({ content: 'SECRET_BLOCK' })
    }
  })
  it('leaves ordinary messages untouched', () => {
    const row = { role: 'assistant', content: 'Here is a summary' }
    expect(getCompactionPlaceholder(row)).toBeNull()
    expect(getTreeMessageText(row)).toBe(row.content)
  })
})

describe('hidden compaction transcript rows', () => {
  it.each([false, true])('hides internal requests without altering history (serialized metadata: %s)', serialized => {
    const rows = [
      { id: 'request', role: 'user', meta: { kind: 'compaction_instruction' } },
      { id: 'partial', role: 'assistant', meta: { compactionPhase: 'summarising' } },
      { id: 'summary', role: 'assistant', meta: { kind: 'compaction_summary', state: 'committed', compactionPhase: 'summarising' } },
      { id: 'resume', role: 'user', meta: { kind: 'compaction_resume' } },
      { id: 'ordinary', role: 'user', content: 'Compaction requested' },
    ].map(row => ({ ...row, meta: serialized ? JSON.stringify(row.meta) : row.meta }))
    expect(rows.filter(row => !isHiddenCompactionMessage(row)).map(row => row.id)).toEqual(['summary', 'resume', 'ordinary'])
    expect(rows.map(row => row.id)).toEqual(['request', 'partial', 'summary', 'resume', 'ordinary'])
    expect(isHiddenCompactionMessage(null)).toBe(false)
  })
})
