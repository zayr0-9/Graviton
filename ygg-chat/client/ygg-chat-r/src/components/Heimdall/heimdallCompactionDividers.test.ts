import { describe, expect, it } from 'vitest'
import { isCommittedCompaction } from '../../../../../shared/compaction'
import type { ChatNode } from '../../features/chats/chatTypes'
import { buildCompactionDividers } from './heimdallCompactionDividers'
import { buildHeimdallVisibleRoot, isHeimdallScaffoldingMessage } from './heimdallNodeVisibility'
import { filterChatTree, layoutChatTree, type HiddenTreeBoundary } from './heimdallTreeTraversal'

const node = (id: string, ...children: ChatNode[]): ChatNode => ({ id, message: id, sender: 'assistant', children })
const summary = { role: 'assistant', meta: { kind: 'compaction_summary', state: 'committed' } }
const options = { compactMode: false, focusedNodeId: null, nodeWidth: 250, nodeHeight: 80, circleRadius: 20, verticalSpacing: 120 }

function filter(root: ChatNode, messages: Record<string, unknown>, enabled = true) {
  const boundaries: HiddenTreeBoundary[] = []
  const roots = filterChatTree(root, n => ({
    promote: isHeimdallScaffoldingMessage(messages[n.id], enabled),
    message: n.message,
    hiddenBoundary: isCommittedCompaction(messages[n.id]),
  }), false, boundaries)
  return { roots, boundaries }
}

function geometry(root: ChatNode, boundaries: HiddenTreeBoundary[], settings = options) {
  const positions = layoutChatTree(root, settings.compactMode ? 100 : 350, settings.verticalSpacing,
    new Set(boundaries.flatMap(boundary => boundary.childIds)))
  return { positions, dividers: buildCompactionDividers(boundaries, positions, settings) }
}

describe('hidden compaction boundaries', () => {
  it('marks only the next visible descendant through hidden controls and context, without mutating the tree', () => {
    const tree = node('before', node('instruction', node('summary', node('resume', node('context', node('after', node('later')))))))
    const original = JSON.stringify(tree)
    const { roots, boundaries } = filter(tree, {
      instruction: { role: 'user', meta: { kind: 'compaction_instruction' } },
      summary,
      context: { role: 'user', meta: { kind: 'context_injection' } },
      resume: { role: 'user', meta: { kind: 'compaction_resume' } },
    })
    expect(boundaries).toEqual([{ parentId: 'before', childIds: ['after'] }])
    expect(roots[0].children[0].id).toBe('after')
    expect(roots[0].children[0].children[0].id).toBe('later')
    expect(JSON.stringify(tree)).toBe(original)
  })

  it('does not mark ordinary messages, controls, pending summaries or partial responses', () => {
    const { boundaries } = filter(node('before', node('instruction', node('partial', node('after')))), {
      instruction: { role: 'user', meta: { kind: 'compaction_instruction' } },
      partial: { role: 'assistant', meta: { compactionPhase: 'summarising' } },
      after: { role: 'assistant', content: 'Context compacted' },
    })
    expect(boundaries).toEqual([])
    expect(isCommittedCompaction({ role: 'assistant', meta: { kind: 'compaction_summary', state: 'pending' } })).toBe(false)
  })

  it('does not mark a summary displayed with filtering disabled', () => {
    const { roots, boundaries } = filter(node('before', node('summary', node('after'))), { summary }, false)
    expect(boundaries).toEqual([])
    expect(roots[0].children[0].id).toBe('summary')
  })

  it.each([
    { role: 'system', note: '__auto_compaction_summary__' },
    { role: 'system', content: 'Following is summary of the session, you have to resume the work.' },
    { ...summary, meta: JSON.stringify(summary.meta) },
  ])('supports legacy and serialised metadata: %j', message => {
    expect(filter(node('before', node('summary', node('after'))), { summary: message }).boundaries)
      .toEqual([{ parentId: 'before', childIds: ['after'] }])
  })

  it('keeps unrelated siblings unmarked and fans out only below the hidden summary', () => {
    const { roots, boundaries } = filter(node('before', node('ordinary'), node('summary', node('a'), node('b'))), { summary })
    expect(roots[0].children.map(child => child.id)).toEqual(['ordinary', 'a', 'b'])
    expect(boundaries).toEqual([{ parentId: 'before', childIds: ['a', 'b'] }])
    expect(geometry(roots[0], boundaries).dividers).toHaveLength(2)
  })

  it('preserves a leading boundary without a visible parent', () => {
    const { roots, boundaries } = filter(node('summary', node('after')), { summary })
    expect(boundaries).toEqual([{ parentId: null, childIds: ['after'] }])
    const { dividers } = geometry(roots[0], boundaries)
    expect(dividers[0].y).toBeLessThan(0)
  })

  it.each([false, true])('clears the synthetic root rail after a leading fan-out in compactMode=%s', compactMode => {
    const { roots, boundaries } = filter(node('summary', node('a'), node('b')), { summary })
    const settings = { ...options, compactMode, verticalSpacing: compactMode ? 80 : 120 }
    const { positions, dividers } = geometry(buildHeimdallVisibleRoot(roots)!, boundaries, settings)
    const parentBottom = compactMode ? 40 : 80
    expect(dividers).toHaveLength(2)
    const branchY = parentBottom + (positions.a.y - parentBottom) * 0.55
    expect(dividers.every(divider => divider.y > branchY && divider.y < positions.a.y)).toBe(true)
  })

  it('does not draw an ambiguous tip marker across an uncompacted sibling', () => {
    const { roots, boundaries } = filter(node('before', node('ordinary'), node('summary')), { summary })
    expect(boundaries).toEqual([{ parentId: 'before', childIds: [] }])
    expect(geometry(roots[0], boundaries).dividers).toEqual([])
  })

  it('coalesces repeated summaries in a hidden gap, but preserves separate later boundaries', () => {
    const { roots, boundaries } = filter(node('before', node('s1', node('s2', node('after', node('s3', node('later')))))),
      { s1: summary, s2: summary, s3: summary })
    expect(boundaries).toEqual([{ parentId: 'before', childIds: ['after'] }, { parentId: 'after', childIds: ['later'] }])
    expect(geometry(roots[0], boundaries).dividers).toHaveLength(2)
  })

  it('renders a completed tip before its next visible descendant exists', () => {
    const { roots, boundaries } = filter(node('before', node('summary')), { summary })
    const { dividers } = geometry(roots[0], boundaries)
    expect(dividers).toHaveLength(1)
    expect(dividers[0].y).toBeGreaterThan(options.nodeHeight)
  })

  it('carries a boundary through a 20,000-deep hidden chain iteratively', () => {
    let tree = node('after')
    for (let i = 0; i < 20000; i++) tree = node(`hidden-${i}`, tree)
    const boundaries: HiddenTreeBoundary[] = []
    const roots = filterChatTree(tree, n => ({ promote: n.id !== 'after', message: n.message,
      hiddenBoundary: n.id === 'hidden-19999' }), false, boundaries)
    expect(roots[0].id).toBe('after')
    expect(boundaries).toEqual([{ parentId: null, childIds: ['after'] }])
  })
})

describe('divider geometry', () => {
  it.each([false, true])('clears parent and child cards in compactMode=%s, including a focused parent', compactMode => {
    const root = node('before', node('after'))
    const settings = { ...options, compactMode, focusedNodeId: 'before', verticalSpacing: compactMode ? 80 : 120 }
    const { positions, dividers } = geometry(root, [{ parentId: 'before', childIds: ['after'] }], settings)
    expect(dividers[0].y).toBeGreaterThan(options.nodeHeight)
    expect(dividers[0].y).toBeLessThan(positions.after.y)
    expect(dividers[0].x2 - dividers[0].x1).toBe(compactMode ? 40 : 250)
  })

  it('places branch markers below the branch rail and above the child', () => {
    const root = node('before', node('a'), node('b'))
    const { positions, dividers } = geometry(root, [{ parentId: 'before', childIds: ['b'] }])
    expect(positions.a.y).toBe(positions.b.y)
    const branchY = options.nodeHeight + (positions.b.y - options.nodeHeight) * 0.55
    expect(dividers[0].y).toBeGreaterThan(branchY)
    expect(dividers[0].y).toBeLessThan(positions.b.y)
    expect((dividers[0].x1 + dividers[0].x2) / 2).toBe(positions.b.x)
  })

  it('keeps ordinary layout unchanged when there are no boundaries', () => {
    expect(layoutChatTree(node('before', node('after')), 350, 120).after.y).toBe(120)
  })
})
