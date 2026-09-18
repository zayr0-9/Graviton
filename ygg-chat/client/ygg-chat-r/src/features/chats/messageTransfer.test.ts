import { describe, expect, it } from 'vitest'
import type { Message } from './chatTypes'
import { buildMessageTransferPayload, hasUnselectedDescendants } from './messageTransfer'

const message = (
  id: string,
  parentId: string | null,
  childrenIds: string[] = [],
  createdAt = '2026-01-01T00:00:00.000Z',
  overrides: Partial<Message> = {}
): Message => ({
  id,
  conversation_id: 'source',
  role: 'user',
  content: id,
  content_plain_text: id,
  parent_id: parentId,
  children_ids: childrenIds,
  created_at: createdAt,
  model_name: 'test',
  partial: false,
  pastedContext: [],
  artifacts: [],
  ...overrides,
})

describe('buildMessageTransferPayload', () => {
  it('preserves a selected multi-branch forest and source sibling order', () => {
    const messages = [
      message('branch-b-leaf', 'branch-b', [], '2026-01-01T00:00:05.000Z'),
      message('branch-a-leaf', 'branch-a', [], '2026-01-01T00:00:04.000Z'),
      message('branch-b', 'root', ['branch-b-leaf'], '2026-01-01T00:00:02.000Z'),
      message('root', null, ['branch-b', 'branch-a'], '2026-01-01T00:00:00.000Z'),
      message('branch-a', 'root', ['branch-a-leaf'], '2026-01-01T00:00:03.000Z'),
    ]

    const payload = buildMessageTransferPayload(messages, [
      'branch-a-leaf',
      'branch-a',
      'root',
      'branch-b-leaf',
      'branch-b',
    ])

    expect(payload.map(item => item.source_id)).toEqual([
      'root',
      'branch-b',
      'branch-b-leaf',
      'branch-a',
      'branch-a-leaf',
    ])
    expect(payload.map(item => [item.source_id, item.parent_source_id])).toEqual([
      ['root', null],
      ['branch-b', 'root'],
      ['branch-b-leaf', 'branch-b'],
      ['branch-a', 'root'],
      ['branch-a-leaf', 'branch-a'],
    ])
  })

  it('keeps selected siblings in source order when their common parent is not selected', () => {
    const parent = message('parent', null, ['second', 'first'])
    const payload = buildMessageTransferPayload(
      [parent, message('first', 'parent'), message('second', 'parent')],
      ['first', 'second']
    )

    expect(payload.map(item => [item.source_id, item.parent_source_id])).toEqual([
      ['second', null],
      ['first', null],
    ])
  })

  it('promotes selected rows whose parents are not selected and preserves metadata', () => {
    const payload = buildMessageTransferPayload(
      [
        message('parent', null, ['child']),
        message('child', 'parent', [], '2026-01-01T00:00:01.000Z', {
          role: 'tool',
          tool_call_id: 'tool-1',
          ex_agent_session_id: 'session-1',
          ex_agent_type: 'subagent',
          meta: { kind: 'context_injection' },
        }),
      ],
      ['child']
    )

    expect(payload).toEqual([
      expect.objectContaining({
        source_id: 'child',
        parent_source_id: null,
        role: 'tool',
        tool_call_id: 'tool-1',
        ex_agent_session_id: 'session-1',
        ex_agent_type: 'subagent',
        meta: { kind: 'context_injection' },
      }),
    ])
  })
})

describe('hasUnselectedDescendants', () => {
  const messages = [
    message('root', null, ['branch-a', 'branch-b']),
    message('branch-a', 'root', ['leaf-a']),
    message('leaf-a', 'branch-a'),
    message('branch-b', 'root'),
  ]

  it('rejects destructive moves that would cascade-delete unselected descendants', () => {
    expect(hasUnselectedDescendants(messages, ['root', 'branch-a', 'leaf-a'])).toBe(true)
  })

  it('accepts complete selected subtrees and independent leaves', () => {
    expect(hasUnselectedDescendants(messages, ['branch-a', 'leaf-a'])).toBe(false)
    expect(hasUnselectedDescendants(messages, ['branch-b'])).toBe(false)
  })
})
