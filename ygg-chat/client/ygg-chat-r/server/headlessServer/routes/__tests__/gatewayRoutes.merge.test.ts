import { describe, expect, it } from 'vitest'
import {
  sortByUpdatedDesc,
  dedupById,
  mergeConversationLists,
  mergeProjects,
  mergeRecent,
  mergeConversationsPaginated,
  mergeByProjectPaginated,
  toLocalConversationCreate,
  toCloudConversationCreate,
  toLocalProjectCreate,
  toCloudProjectCreate,
  toCloudProjectUpdate,
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

  it('mergeConversationLists dedups by id (a cloud entity mirrored locally must not appear twice)', () => {
    const out = mergeConversationLists([row('x', '2021-01-01')], [row('x', '2022-01-01')])
    expect(out).toHaveLength(1)
    expect(out[0].updated_at).toBe('2022-01-01') // first after sort-desc wins
  })

  it('dedupById keeps first occurrence and preserves rows without ids', () => {
    expect(dedupById([{ id: 'a' }, { id: 'a' }, { id: 'b' }]).map(r => r.id)).toEqual(['a', 'b'])
    expect(dedupById([{}, {}]).length).toBe(2) // no id → never merged
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

describe('gateway write normalizers (canonical camelCase → each backend shape)', () => {
  it('toLocalConversationCreate maps camel→snake and forces storage_mode local', () => {
    const out = toLocalConversationCreate({
      userId: 'u1',
      title: 'T',
      projectId: 'p1',
      systemPrompt: 'sp',
      conversationContext: 'ctx',
      cwd: '/tmp',
    })
    expect(out).toMatchObject({
      user_id: 'u1',
      title: 'T',
      project_id: 'p1',
      system_prompt: 'sp',
      conversation_context: 'ctx',
      cwd: '/tmp',
      storage_mode: 'local',
    })
  })

  it('toCloudConversationCreate keeps Railway camelCase and drops cwd/storageMode', () => {
    const out = toCloudConversationCreate({ userId: 'u1', title: 'T', projectId: 'p1', cwd: '/tmp', storageMode: 'cloud' })
    expect(out).toEqual({ userId: 'u1', title: 'T', projectId: 'p1', systemPrompt: undefined, conversationContext: undefined })
    expect('cwd' in out).toBe(false)
    expect('storageMode' in out).toBe(false)
  })

  it('project create normalizers: local carries cwd + user_id, cloud drops cwd but keeps userId (snake system_prompt both)', () => {
    const canonical = { userId: 'u1', name: 'P', system_prompt: 'sp', cwd: '/tmp' }
    expect(toLocalProjectCreate(canonical)).toMatchObject({ user_id: 'u1', name: 'P', system_prompt: 'sp', cwd: '/tmp' })
    const cloud = toCloudProjectCreate(canonical)
    expect(cloud).toEqual({ userId: 'u1', name: 'P', context: null, system_prompt: 'sp' })
    expect('cwd' in cloud).toBe(false)
  })

  it('toCloudProjectUpdate strips local-only fields (cwd / storage mode)', () => {
    const out = toCloudProjectUpdate({ name: 'P', context: 'c', system_prompt: 'sp', cwd: '/tmp', storage_mode: 'cloud', storageMode: 'cloud' })
    expect(out).toEqual({ name: 'P', context: 'c', system_prompt: 'sp' })
  })
})
