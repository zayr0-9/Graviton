import { describe, expect, it } from 'vitest'
import {
  CLAUDE_TRANSFER_REFUSED_MESSAGE,
  claudeTransferRefusal,
  isTransferredMessage,
  transferredSummaryAtTip,
} from '../../../../../shared/claudeTransfer'

const claude = { provider: 'claudecode', model: 'claude-opus-5-5' }
const gpt = { provider: 'openaichatgpt', model: 'gpt-a' }

// A Claude chat: response, /compact, summary, then real work after the summary.
const rows = [
  { id: 'u0', parent_id: null, role: 'user', content: 'start', meta: { modelSelection: claude } },
  { id: 'a0', parent_id: 'u0', role: 'assistant', content: 'done', meta: JSON.stringify({ modelSelection: claude, claude: { sessionId: 's', checkpoint: true } }) },
  { id: 'i', parent_id: 'a0', role: 'user', content: '/compact', meta: { kind: 'compaction_instruction', modelSelection: claude } },
  { id: 's', parent_id: 'i', role: 'assistant', content: 'Portable state', meta: { kind: 'compaction_summary', state: 'committed', claude: { sessionId: 's' } } },
  { id: 'ctx', parent_id: 's', role: 'user', content: 'restored', meta: { kind: 'context_injection' } },
  { id: 'u1', parent_id: 's', role: 'user', content: 'more', meta: { modelSelection: claude } },
  { id: 'a1', parent_id: 'u1', role: 'assistant', content: 'reply', meta: { modelSelection: claude, claude: { sessionId: 's', checkpoint: true } } },
  // A GPT branch handed off from the Claude summary.
  { id: 'g1', parent_id: 's', role: 'user', content: 'gpt', meta: { modelSelection: gpt, executionHandoff: { summaryMessageId: 's' } } },
  { id: 'g2', parent_id: 'g1', role: 'assistant', content: 'gpt reply', meta: {} },
]

describe('claudeTransferRefusal', () => {
  it('allows a Claude selection that ends at its summary, including the messages before it', () => {
    expect(claudeTransferRefusal(rows, ['a0', 'i', 's'])).toBeNull()
    expect(claudeTransferRefusal(rows, ['s'])).toBeNull()
  })

  it('allows context rows directly after the summary, but only with the summary selected', () => {
    expect(claudeTransferRefusal(rows, ['s', 'ctx'])).toBeNull()
    expect(claudeTransferRefusal(rows, ['ctx'])).toBe(CLAUDE_TRANSFER_REFUSED_MESSAGE)
  })

  it('refuses Claude work after the summary, or a Claude branch with no summary at all', () => {
    expect(claudeTransferRefusal(rows, ['s', 'u1', 'a1'])).toBe(CLAUDE_TRANSFER_REFUSED_MESSAGE)
    expect(claudeTransferRefusal(rows, ['u0', 'a0'])).toBe(CLAUDE_TRANSFER_REFUSED_MESSAGE)
    expect(claudeTransferRefusal(rows, ['i'])).toBe(CLAUDE_TRANSFER_REFUSED_MESSAGE)
  })

  it('checks every selected branch tip', () => {
    expect(claudeTransferRefusal(rows, ['s', 'ctx', 'u1', 'a1'])).toBe(CLAUDE_TRANSFER_REFUSED_MESSAGE)
  })

  it('treats a branch handed off to another provider as that provider', () => {
    expect(claudeTransferRefusal(rows, ['s', 'g1', 'g2'])).toBeNull()
    expect(claudeTransferRefusal(rows, ['g2'])).toBeNull()
  })

  it('never restricts other providers or unknown ids', () => {
    const other = [
      { id: 'x', parent_id: null, role: 'user', content: 'hi', meta: { modelSelection: gpt } },
      { id: 'y', parent_id: 'x', role: 'assistant', content: 'hello', meta: null },
    ]
    expect(claudeTransferRefusal(other, ['x', 'y'])).toBeNull()
    expect(claudeTransferRefusal(other, ['missing'])).toBeNull()
  })
})

describe('transferred summaries', () => {
  const copied = [
    { id: 'cs', parent_id: null, role: 'assistant', content: 'Portable state', meta: { kind: 'compaction_summary', state: 'committed', transfer: { sourceMessageId: 's' } } },
    { id: 'cc', parent_id: 'cs', role: 'user', content: 'restored', meta: { kind: 'context_injection', transfer: { sourceMessageId: 'ctx' } } },
    { id: 'native', parent_id: null, role: 'assistant', content: 'Portable state', meta: { kind: 'compaction_summary', state: 'committed' } },
  ]
  const rowOf = (id: string) => copied.find(row => row.id === id)

  it('marks copied rows and finds a copied summary through trailing context rows', () => {
    expect(isTransferredMessage(copied[0])).toBe(true)
    expect(isTransferredMessage(copied[2])).toBe(false)
    expect(transferredSummaryAtTip(copied[0], rowOf)?.id).toBe('cs')
    expect(transferredSummaryAtTip(copied[1], rowOf)?.id).toBe('cs')
  })

  it('ignores a summary that was not copied', () => {
    expect(transferredSummaryAtTip(copied[2], rowOf)).toBeNull()
  })
})
