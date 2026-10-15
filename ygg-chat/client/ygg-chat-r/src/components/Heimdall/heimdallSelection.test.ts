import { describe, expect, it } from 'vitest'
import type { Message } from '../../features/chats/chatTypes'
import { buildMessageTransferPayload, hasUnselectedDescendants } from '../../features/chats/messageTransfer'
import { expandHeimdallSelectionToBranchMessages, selectHeimdallContextMenuNodes } from './heimdallSelection'

const message = (id: string, parentId: string | null, role: Message['role'] = 'user'): Message => ({
  id,
  conversation_id: 'source',
  parent_id: parentId,
  children_ids: [],
  role,
  content: role === 'tool' ? '' : id,
  content_plain_text: id,
  created_at: '2026-01-01T00:00:00.000Z',
  model_name: 'test',
  partial: false,
  pastedContext: [],
  artifacts: [],
})

// Deliberately shuffled snapshot: neither snapshot order nor click order is branch order.
const messages = [
  message('c', 'hidden-b'),
  message('other-branch', 'before'),
  message('hidden-b', 'b', 'tool'),
  message('after', 'c'),
  message('b', 'hidden-a'),
  message('before', null),
  message('hidden-a', 'a', 'tool'),
  message('a', 'before'),
]

const transferSelection = (ids: string[]) =>
  buildMessageTransferPayload(messages, expandHeimdallSelectionToBranchMessages(messages, ids))

const relations = (payload: ReturnType<typeof transferSelection>) =>
  payload.map(item => [item.source_id, item.parent_source_id])

const expectedMiddleBranch = [
  ['a', null],
  ['hidden-a', 'a'],
  ['b', 'hidden-a'],
  ['hidden-b', 'b'],
  ['c', 'hidden-b'],
]

describe('selectHeimdallContextMenuNodes', () => {
  it('preserves all three selected messages when right-clicking the middle one', () => {
    const selected = selectHeimdallContextMenuNodes(['c', 'a', 'b'], 'b', false)
    expect(selected).toEqual(['c', 'a', 'b'])
    expect(relations(transferSelection(selected))).toEqual(expectedMiddleBranch)
  })

  it('replaces the selection when right-clicking an unselected message', () => {
    expect(selectHeimdallContextMenuNodes(['a', 'b'], 'c', false)).toEqual(['c'])
  })

  it('retains modifier toggle behavior, including deselecting the final node', () => {
    expect(selectHeimdallContextMenuNodes(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(selectHeimdallContextMenuNodes(['a', 'b'], 'b', true)).toEqual(['a'])
    expect(selectHeimdallContextMenuNodes(['a'], 'a', true)).toEqual([])
  })
})

describe('expandHeimdallSelectionToBranchMessages', () => {
  it('copies three middle-of-branch messages in source order with hidden connecting rows', () => {
    expect(relations(transferSelection(['c', 'a', 'b']))).toEqual(expectedMiddleBranch)
  })

  it('is idempotent for already-expanded rectangle selections', () => {
    const expanded = expandHeimdallSelectionToBranchMessages(messages, ['c', 'a', 'b'])
    expect(expandHeimdallSelectionToBranchMessages(messages, expanded)).toEqual(expanded)
    expect(relations(transferSelection(expanded))).toEqual(expectedMiddleBranch)
  })

  it('does not add unselected common ancestors or unrelated branches', () => {
    expect(relations(transferSelection(['c', 'other-branch']))).toEqual([
      ['other-branch', null],
      ['c', null],
    ])
  })

  it('keeps a single selected message independent', () => {
    expect(relations(transferSelection(['b']))).toEqual([['b', null]])
    expect(expandHeimdallSelectionToBranchMessages(messages, [])).toEqual([])
  })

  it('preserves a contiguous middle segment regardless of click order', () => {
    const chain = [message('before', null), message('a', 'before'), message('b', 'a'), message('c', 'b')]
    expect(relations(buildMessageTransferPayload(chain, expandHeimdallSelectionToBranchMessages(chain, ['c', 'b', 'a']))))
      .toEqual([['a', null], ['b', 'a'], ['c', 'b']])
  })

  it('validates moves using the expanded copy IDs and still rejects unselected descendants', () => {
    const middleIds = transferSelection(['a', 'b', 'c']).map(item => item.source_id)
    expect(hasUnselectedDescendants(messages, middleIds)).toBe(true)
    const completeIds = transferSelection(['a', 'b', 'c', 'after']).map(item => item.source_id)
    expect(hasUnselectedDescendants(messages, completeIds)).toBe(false)
  })

  it('terminates on cyclic or missing ancestry without inventing connecting rows', () => {
    const malformed = [message('a', 'b'), message('b', 'a'), message('c', 'missing')]
    expect(expandHeimdallSelectionToBranchMessages(malformed, ['a', 'c'])).toEqual(['a', 'c'])
    expect(expandHeimdallSelectionToBranchMessages([], ['a', 'c'])).toEqual(['a', 'c'])
  })
})

describe('hidden branch tails', () => {
  const summary: Message = {
    ...message('summary', 'last-user', 'assistant'),
    content: 'Persisted compaction summary',
    meta: { kind: 'compaction_summary', state: 'committed' },
  }
  const tail = [
    message('resume', 'summary'),
    summary,
    message('last-user', 'hidden-context'),
    message('hidden-context', 'first-user'),
    message('first-user', null),
  ]
  const visibleIds = new Set(['first-user', 'last-user'])
  const transfer = (ids: Message['id'][], visible = visibleIds) =>
    buildMessageTransferPayload(tail, expandHeimdallSelectionToBranchMessages(tail, ids, visible))

  it('includes the hidden compaction tail and connecting rows when selecting the visible branch', () => {
    const payload = transfer(['last-user', 'first-user'])
    expect(relations(payload)).toEqual([
      ['first-user', null],
      ['hidden-context', 'first-user'],
      ['last-user', 'hidden-context'],
      ['summary', 'last-user'],
      ['resume', 'summary'],
    ])
    expect(payload.find(row => row.source_id === 'summary')).toMatchObject({
      content: summary.content,
      meta: summary.meta,
    })
    expect(hasUnselectedDescendants(tail, payload.map(row => row.source_id))).toBe(false)
  })

  it('includes a hidden tail for a single selected visible leaf without adding ancestors', () => {
    expect(relations(transfer(['last-user']))).toEqual([
      ['last-user', null], ['summary', 'last-user'], ['resume', 'summary'],
    ])
    expect(expandHeimdallSelectionToBranchMessages(tail, [], visibleIds)).toEqual([])
  })

  it('is idempotent when a rectangle selection is expanded again for transfer', () => {
    const expanded = expandHeimdallSelectionToBranchMessages(tail, ['first-user', 'last-user'], visibleIds)
    expect(expandHeimdallSelectionToBranchMessages(tail, expanded, visibleIds)).toEqual(expanded)
  })

  it('does not include the tail when those messages are visible with filtering off', () => {
    const allVisible = new Set(tail.map(row => String(row.id)))
    const payload = transfer(['last-user'], allVisible)
    expect(relations(payload)).toEqual([['last-user', null]])
    expect(hasUnselectedDescendants(tail, payload.map(row => row.source_id))).toBe(true)
  })

  it('does not absorb a hidden prefix leading to an unselected visible turn', () => {
    const continued = [...tail, message('next-turn', 'resume')]
    const visible = new Set([...visibleIds, 'next-turn'])
    const expanded = expandHeimdallSelectionToBranchMessages(continued, ['last-user'], visible)
    expect(expanded).toEqual(['last-user'])
    expect(hasUnselectedDescendants(continued, expanded)).toBe(true)
  })

  it('includes hidden-only forks but not visible sibling branches or unrelated hidden roots', () => {
    const branched = [
      ...tail,
      message('hidden-fork', 'summary'),
      message('visible-sibling', 'last-user'),
      message('sibling-tail', 'visible-sibling'),
      message('unrelated-hidden-root', null),
    ]
    const visible = new Set([...visibleIds, 'visible-sibling'])
    const expanded = expandHeimdallSelectionToBranchMessages(branched, ['last-user'], visible)
    expect(new Set(expanded)).toEqual(new Set(['last-user', 'summary', 'resume', 'hidden-fork']))
    expect(hasUnselectedDescendants(branched, expanded)).toBe(true)
  })

  it('normalizes numeric IDs and terminates on cyclic descendants', () => {
    // Legacy runtime rows can contain numeric IDs despite the current string-only type.
    const numeric = [{ ...message('1', null), id: 1 }, { ...message('2', '1'), id: 2 }] as unknown as Message[]
    expect(expandHeimdallSelectionToBranchMessages(numeric, ['1'], new Set(['1']))).toEqual([1, 2])
    const cyclic = [message('a', 'b'), message('b', 'a')]
    expect(expandHeimdallSelectionToBranchMessages(cyclic, ['a'], new Set(['a']))).toEqual(['a'])
  })
})
