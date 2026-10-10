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
