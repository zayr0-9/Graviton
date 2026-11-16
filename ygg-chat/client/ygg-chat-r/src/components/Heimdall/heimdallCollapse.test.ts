import { describe, expect, it } from 'vitest'
import type { ChatNode, Message } from '../../features/chats/chatTypes'
import {
  applyHeimdallCollapse,
  getHeimdallCollapseGroupsInSelection,
  planHeimdallCollapse,
  type HeimdallCollapseGroup,
} from './heimdallCollapse'
import { selectHeimdallContextMenuNodes } from './heimdallSelection'

const node = (id: string, children: ChatNode[] = []): ChatNode => ({ id, message: id, sender: 'user', children })

const message = (id: string, parentId: string | null, role: Message['role'] = 'user'): Message => ({
  id,
  conversation_id: 'c1',
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

const shape = (tree: ChatNode | null): unknown => {
  if (!tree) return null
  const out: Record<string, unknown> = {}
  const pending: Array<{ node: ChatNode; into: Record<string, unknown> }> = [{ node: tree, into: out }]
  while (pending.length) {
    const { node: current, into } = pending.pop()!
    const children: Record<string, unknown> = {}
    into[current.id] = children
    for (const child of current.children) pending.push({ node: child, into: children })
  }
  return out
}

// a -> b -> c -> d, and b -> x (a side branch leaving the middle of the run)
const tree = () => node('a', [node('b', [node('c', [node('d')]), node('x')])])

describe('applyHeimdallCollapse', () => {
  it('returns the tree unchanged without groups', () => {
    const root = tree()
    expect(applyHeimdallCollapse(root, []).root).toBe(root)
  })

  it('replaces a connected run with its head and reattaches exits in preorder', () => {
    const { root, collapsedById, headByMemberId } = applyHeimdallCollapse(tree(), [{ id: 'g', memberIds: ['b', 'c'] }])
    expect(shape(root)).toEqual({ a: { b: { d: {}, x: {} } } })
    expect(collapsedById.get('b')).toEqual({ groupId: 'g', visibleMemberIds: ['b', 'c'] })
    expect(headByMemberId.get('c')).toBe('b')
    expect(headByMemberId.has('d')).toBe(false)
  })

  it('leaves single-member segments alone and ignores members missing from the tree', () => {
    const { root, collapsedById } = applyHeimdallCollapse(tree(), [{ id: 'g', memberIds: ['d', 'gone'] }])
    expect(shape(root)).toEqual(shape(tree()))
    expect(collapsedById.size).toBe(0)
  })

  it('never collapses the synthetic multi-root wrapper', () => {
    const forest: ChatNode = { id: 'root', message: 'Conversation', sender: 'assistant', children: [node('p', [node('q')]), node('r')] }
    const { root } = applyHeimdallCollapse(forest, [{ id: 'g', memberIds: ['root', 'p', 'q'] }])
    expect(shape(root)).toEqual({ root: { p: {}, r: {} } })
  })

  it('handles very deep trees without recursion', () => {
    let leaf = node('n19999')
    for (let i = 19998; i >= 0; i--) leaf = node(`n${i}`, [leaf])
    const memberIds = Array.from({ length: 19990 }, (_, i) => `n${i + 5}`)
    const { root, collapsedById } = applyHeimdallCollapse(leaf, [{ id: 'g', memberIds }])
    expect(collapsedById.get('n5')?.visibleMemberIds).toHaveLength(19990)
    let depth = 0
    for (let current = root; current; current = current.children[0]) depth++
    expect(depth).toBe(6 + 5) // n0..n5 then n19995..n19999
  })
})

describe('planHeimdallCollapse', () => {
  const messages = [
    message('a', null),
    message('b', 'a'),
    message('hidden', 'b', 'tool'),
    message('c', 'hidden'),
    message('d', 'c'),
    message('x', 'b'),
  ]
  // The filtered tree promotes the hidden tool row away.
  const visibleRoot = tree()

  it('collapses a connected selection and keeps hidden connector rows', () => {
    const plan = planHeimdallCollapse({ visibleRoot, messages, selectedIds: ['b', 'c'], groups: [] })
    expect(plan.kind).toBe('collapse')
    if (plan.kind !== 'collapse') return
    expect(plan.visibleCount).toBe(2)
    expect(new Set(plan.group.memberIds)).toEqual(new Set(['b', 'hidden', 'c']))
    expect(plan.replacedGroupIds).toEqual([])
  })

  it('refuses fewer than two nodes and disconnected selections', () => {
    expect(planHeimdallCollapse({ visibleRoot, messages, selectedIds: ['b'], groups: [] }).kind).toBe('unavailable')
    expect(planHeimdallCollapse({ visibleRoot, messages, selectedIds: ['a', 'c'], groups: [] }))
      .toEqual({ kind: 'unavailable', reason: 'Select one connected run of messages to collapse' })
    expect(planHeimdallCollapse({ visibleRoot, messages, selectedIds: ['d', 'x'], groups: [] }).kind).toBe('unavailable')
  })

  it('merges groups the selection touches and reports an exact group as a no-op', () => {
    const groups: HeimdallCollapseGroup[] = [{ id: 'old', memberIds: ['c', 'd'] }]
    expect(planHeimdallCollapse({ visibleRoot, messages, selectedIds: ['c', 'd'], groups })).toEqual({ kind: 'noop' })

    const plan = planHeimdallCollapse({ visibleRoot, messages, selectedIds: ['b', 'c'], groups })
    expect(plan.kind).toBe('collapse')
    if (plan.kind !== 'collapse') return
    expect(plan.replacedGroupIds).toEqual(['old'])
    expect(new Set(plan.group.memberIds)).toEqual(new Set(['b', 'hidden', 'c', 'd']))
    expect(plan.visibleCount).toBe(3)
  })

  it('finds groups intersecting a selection for Expand', () => {
    const groups: HeimdallCollapseGroup[] = [{ id: 'g1', memberIds: ['b', 'c'] }, { id: 'g2', memberIds: ['x', 'y'] }]
    expect(getHeimdallCollapseGroupsInSelection(groups, ['c']).map(group => group.id)).toEqual(['g1'])
    expect(getHeimdallCollapseGroupsInSelection(groups, ['a'])).toEqual([])
  })
})

describe('collapse selection', () => {
  it('selects and toggles every member of a collapse node together', () => {
    expect(selectHeimdallContextMenuNodes([], 'b', false, ['b', 'c'])).toEqual(['b', 'c'])
    expect(selectHeimdallContextMenuNodes(['a'], 'b', true, ['b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(selectHeimdallContextMenuNodes(['a', 'b', 'c'], 'b', true, ['b', 'c'])).toEqual(['a'])
  })
})
