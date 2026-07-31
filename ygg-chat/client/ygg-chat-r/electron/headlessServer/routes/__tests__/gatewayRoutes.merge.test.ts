import { describe, expect, it } from 'vitest'
import {
  sortByUpdatedDesc,
  mergeConversationLists,
  mergeProjects,
  mergeRecent,
  mergeConversationsPaginated,
  mergeByProjectPaginated,
} from '../gatewayRoutes.js'

const row = (id: string, updated_at: string, extra: Record<string, any> = {}) => ({ id, updated_at, ...extra })

describe('gateway merge helpers', () => {
  it('sortByUpdatedDesc orders newest-first and tolerates bad dates', () => {
    const out = sortByUpdatedDesc([row('a', '2020-01-01'), row('b', '2022-01-01'), row('c', 'not-a-date')])
    expect(out.map(r => r.id)).toEqual(['b', 'a', 'c'])
  })

  it('mergeConversationLists concatenates local+cloud and sorts updated_at desc (no dedup)', () => {
    const local = [row('l1', '2021-05-01')]
    const cloud = [row('c1', '2023-01-01'), row('c2', '2020-01-01')]
    expect(mergeConversationLists(local, cloud).map(r => r.id)).toEqual(['c1', 'l1', 'c2'])
  })

  it('mergeConversationLists does NOT dedup ids (partition invariant is assumed)', () => {
    // A pathological same-id-in-both case is preserved (two rows), matching the renderer.
    const out = mergeConversationLists([row('x', '2021-01-01')], [row('x', '2022-01-01')])
    expect(out).toHaveLength(2)
  })

  it('mergeProjects orders by latest_conversation_updated_at || updated_at desc, cloud-first', () => {
    const cloud = [row('c', '2020-01-01', { latest_conversation_updated_at: '2024-01-01' })]
    const local = [row('l', '2023-06-01')]
    expect(mergeProjects(cloud, local).map(r => r.id)).toEqual(['c', 'l'])
  })

  it('mergeRecent normalizes cloud rows (owner_id→user_id, id→String) and slices to limit', () => {
    const cloud = [{ id: 7, owner_id: 'owner-7', project_id: 3, updated_at: '2024-01-01' }]
    const local = [row('l', '2023-01-01', { user_id: 'u-local' })]
    const out = mergeRecent(cloud as any, local, 1)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('7')
    expect(out[0].user_id).toBe('owner-7')
    expect(out[0].project_id).toBe('3')
  })

  describe('mergeConversationsPaginated (region A)', () => {
    it('first page merges the FULL local list with the cloud page and slices to pageSize', () => {
      const localAll = [row('l1', '2024-01-01'), row('l2', '2024-02-01')]
      const cloud = { conversations: [row('c1', '2024-03-01')], nextCursor: 'CUR', hasMore: true }
      const out = mergeConversationsPaginated(undefined, localAll, cloud, 50)
      expect(out.conversations.map(r => r.id)).toEqual(['c1', 'l2', 'l1'])
      expect(out.nextCursor).toBe('CUR')
      expect(out.hasMore).toBe(true)
    })

    it('first page reports hasMore when merged length exceeds pageSize even if cloud says no more', () => {
      const localAll = [row('l1', '2024-01-01'), row('l2', '2024-02-01'), row('l3', '2024-03-01')]
      const cloud = { conversations: [], nextCursor: null, hasMore: false }
      const out = mergeConversationsPaginated(undefined, localAll, cloud, 2)
      expect(out.conversations).toHaveLength(2)
      expect(out.hasMore).toBe(true)
    })

    it('subsequent pages are cloud-only (local already injected on page 1)', () => {
      const cloud = { conversations: [row('c9', '2024-03-01')], nextCursor: 'C2', hasMore: false }
      const out = mergeConversationsPaginated('some-cursor', [row('l1', '2024-01-01')], cloud, 50)
      expect(out.conversations.map(r => r.id)).toEqual(['c9'])
      expect(out.nextCursor).toBe('C2')
      expect(out.hasMore).toBe(false)
    })
  })

  describe('mergeByProjectPaginated (region B, dual-cursor)', () => {
    it('drains local first: nextCursor is local while local hasMore', () => {
      const local = { conversations: [row('l1', '2024-02-01')], nextCursor: 'L2', hasMore: true }
      const cloud = { conversations: [row('c1', '2024-03-01')], nextCursor: 'C2', hasMore: true }
      const out = mergeByProjectPaginated(local, cloud)
      expect(out.conversations.map(r => r.id)).toEqual(['c1', 'l1'])
      expect(out.nextCursor).toBe('L2') // local not yet exhausted
      expect(out.hasMore).toBe(true)
    })

    it('switches to the cloud cursor once local is exhausted', () => {
      const local = { conversations: [row('l1', '2024-02-01')], nextCursor: null, hasMore: false }
      const cloud = { conversations: [row('c1', '2024-03-01')], nextCursor: 'C2', hasMore: true }
      const out = mergeByProjectPaginated(local, cloud)
      expect(out.nextCursor).toBe('C2')
      expect(out.hasMore).toBe(true)
    })

    it('hasMore is the OR of both legs; false only when both are done', () => {
      const done = { conversations: [], nextCursor: null, hasMore: false }
      expect(mergeByProjectPaginated(done, done).hasMore).toBe(false)
    })
  })
})
