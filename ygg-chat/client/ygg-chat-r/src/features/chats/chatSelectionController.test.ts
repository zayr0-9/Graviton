import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
})
import reducer, { chatSliceActions as actions } from './chatSlice'
import { createChatSelectionController, type LineageSelectionDetail } from './chatSelectionController'
import { chatSelectionScrollHandled } from './chatSelection'
import { selectCurrentViewStreamFor } from './chatSelectors'
import type { Message } from './chatTypes'
import { applyStreamProjectionPolicy, projectServerEvent } from './sseProjection'

const rows = [
  { id: 'root', parent_id: null }, { id: 'a', parent_id: 'root' }, { id: 'b', parent_id: 'root' },
].map(row => ({ ...row, role: 'user', conversation_id: 'c', created_at: '2026-01-01', children_ids: [] })) as Message[]
function setup(loadLineage = vi.fn(async (): Promise<LineageSelectionDetail> => ({ pathMessageIds: ['root', 'a'] }))) {
  let state = reducer(undefined, { type: 'init' })
  let n = 0
  const dispatch = (action: any) => { state = reducer(state, action) }
  const controller = createChatSelectionController({ getState: () => state, dispatch, loadLineage, createRequestId: () => `request-${++n}` })
  const snapshot = (conversationId = 'c') => dispatch(actions.conversationSnapshotApplied({
    conversationId, messages: rows.map(row => ({ ...row, conversation_id: conversationId })), tree: null,
  }))
  return { controller, dispatch, snapshot, get: () => state, loadLineage }
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('central selection controller', () => {
  it('waits for the matching accepted snapshot, then commits atomically', async () => {
    const h = setup()
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'b' }, 'search')
    await h.controller.resolve(null, vi.fn())
    expect(h.get().selection.status).toBe('pending')
    h.snapshot()
    await h.controller.resolve('c', vi.fn())
    expect(h.get().conversation).toMatchObject({ currentConversationId: 'c', currentPath: ['root', 'b'], focusedChatMessageId: 'b' })
    expect(h.get().selection.status).toBe('ready')
  })
  it('makes identical clicks new focus intents without replaying on snapshot refresh', async () => {
    const h = setup()
    const target = { kind: 'message' as const, conversationId: 'c', messageId: 'b' }
    const first = h.controller.request(target, 'pill')
    h.snapshot()
    await h.controller.resolve('c', vi.fn())
    h.dispatch(chatSelectionScrollHandled(first))
    h.snapshot()
    await h.controller.resolve('c', vi.fn())
    expect(h.get().selection.scroll).toBeNull()
    const second = h.controller.request(target, 'pill')
    await h.controller.resolve('c', vi.fn())
    expect(second).not.toBe(first)
    expect(h.get().selection.scroll?.requestId).toBe(second)
  })
  it('rejects a late lineage response after manual sibling selection', async () => {
    const response = deferred<LineageSelectionDetail>()
    const h = setup(vi.fn(() => response.promise))
    h.controller.request({ kind: 'lineage', conversationId: 'c', lineageId: 'fork-a' }, 'route')
    h.snapshot()
    const pending = h.controller.resolve('c', vi.fn())
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'b' }, 'heimdall')
    await h.controller.resolve('c', vi.fn())
    response.resolve({ pathMessageIds: ['root', 'a'] })
    await pending
    expect(h.get().conversation.currentPath).toEqual(['root', 'b'])
  })
  it('rejects an old A response after A → B → A', async () => {
    const response = deferred<LineageSelectionDetail>()
    const h = setup(vi.fn(() => response.promise))
    h.controller.request({ kind: 'lineage', conversationId: 'c', lineageId: 'old' }, 'route')
    h.snapshot()
    const pending = h.controller.resolve('c', vi.fn())
    h.controller.request({ kind: 'conversation', conversationId: 'other' }, 'route')
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'b' }, 'route')
    h.snapshot()
    await h.controller.resolve('c', vi.fn())
    response.resolve({ pathMessageIds: ['root', 'a'] })
    await pending
    expect(h.get().conversation.currentPath).toEqual(['root', 'b'])
  })
  it('refreshes a missing target once, falls back observably, and allows retry', async () => {
    const h = setup()
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'gone' }, 'link')
    h.snapshot()
    const refresh = vi.fn(async () => {})
    await h.controller.resolve('c', refresh)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(h.get().selection.error).toContain('no longer available')
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'b' }, 'link')
    await h.controller.resolve('c', refresh)
    expect(h.get().selection.error).toBeNull()
  })
  it('cancels pending lookups without aborting generation', async () => {
    const response = deferred<LineageSelectionDetail>()
    const h = setup(vi.fn(() => response.promise))
    h.controller.request({ kind: 'lineage', conversationId: 'c', lineageId: 'a' }, 'route')
    h.snapshot()
    h.dispatch(actions.sendingStarted({ streamId: 'run', conversationId: 'c' }))
    const pending = h.controller.resolve('c', vi.fn())
    h.controller.cancel()
    response.resolve({ pathMessageIds: ['root', 'a'] })
    await pending
    expect(h.get().selection.status).toBe('idle')
    expect(h.get().streaming.byId.run.active).toBe(true)
  })
  it('deduplicates concurrent resolution and validates focus within authoritative lineage', async () => {
    const response = deferred<LineageSelectionDetail>()
    const h = setup(vi.fn(() => response.promise))
    h.controller.request({ kind: 'lineage', conversationId: 'c', lineageId: 'a', messageId: 'b' }, 'pill')
    h.snapshot()
    const pending = h.controller.resolve('c', vi.fn())
    await h.controller.resolve('c', vi.fn())
    response.resolve({ pathMessageIds: ['root', 'a'] })
    await pending
    expect(h.loadLineage).toHaveBeenCalledTimes(1)
    expect(h.get().conversation).toMatchObject({ currentLineageId: 'a', focusedChatMessageId: 'a' })
  })
})

describe('navigation versus background projection', () => {
  it('does not let delayed first-user persistence steal the newly selected branch', async () => {
    const h = setup()
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'a' }, 'route')
    h.snapshot()
    await h.controller.resolve('c', vi.fn())
    h.dispatch(actions.sendingStarted({ streamId: 'old', conversationId: 'c' }))
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'b' }, 'search')
    await h.controller.resolve('c', vi.fn())
    const message = { ...rows[0], id: 'new-user', parent_id: 'a' }
    for (const action of projectServerEvent({ type: 'user_message_persisted', message } as any, { streamId: 'old', conversationId: 'c' })) h.dispatch(action)
    expect(h.get().conversation.currentPath).toEqual(['root', 'b'])
    expect(h.get().conversation.messages.some(row => row.id === 'new-user')).toBe(true)
    expect(h.get().streaming.byId.old.active).toBe(true)
  })
  it('keeps parallel first-user insertion off the primary path', async () => {
    const h = setup()
    h.controller.request({ kind: 'message', conversationId: 'c', messageId: 'a' }, 'route')
    h.snapshot()
    await h.controller.resolve('c', vi.fn())
    h.dispatch(actions.sendingStarted({ streamId: 'parallel', conversationId: 'c', updatePath: false }))
    const message = { ...rows[0], id: 'parallel-user', parent_id: 'a' }
    for (const action of projectServerEvent({ type: 'user_message_persisted', message } as any, { streamId: 'parallel', conversationId: 'c' })) {
      h.dispatch(applyStreamProjectionPolicy(action, { streamId: 'parallel', streamType: 'branch', updatePath: false }))
    }
    expect(h.get().conversation.currentPath).toEqual(['root', 'a'])
  })
  it('excludes confirmed mismatched lineages even when message anchors overlap', () => {
    const h = setup()
    h.dispatch(actions.sendingStarted({ streamId: 'a', conversationId: 'c', lineage: { rootMessageId: 'root' } }))
    h.dispatch(actions.streamLineageUpdated({ streamId: 'a', lineageId: 'fork-a' }))
    expect(selectCurrentViewStreamFor(h.get().streaming, { conversationId: 'c', lineageId: 'fork-b', path: ['root'] })).toBeNull()
  })
})

describe('review regressions', () => {
  it('turns initial snapshot failure into a retryable error rather than an infinite pending state', () => {
    const h = setup()
    h.controller.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    h.controller.snapshotFailed('other')
    expect(h.get().selection.status).toBe('pending')
    h.controller.snapshotFailed('c')
    expect(h.get().selection.status).toBe('error')
    h.controller.request({ kind: 'conversation', conversationId: 'c' }, 'retry')
    expect(h.get().selection.status).toBe('pending')
  })
  it('retains startup ownership for same-view refocus, but never revives it after switching away/back', async () => {
    const h = setup()
    const a = { kind: 'message' as const, conversationId: 'c', messageId: 'a' }
    h.controller.request(a, 'route')
    h.snapshot()
    await h.controller.resolve('c', vi.fn())
    const owner = h.get().selection.fallbackRevision
    h.controller.request(a, 'search')
    await h.controller.resolve('c', vi.fn())
    expect(h.get().selection.fallbackRevision).toBe(owner)
    h.controller.request({ ...a, messageId: 'b' }, 'search')
    await h.controller.resolve('c', vi.fn())
    h.controller.request(a, 'search')
    await h.controller.resolve('c', vi.fn())
    expect(h.get().selection.fallbackRevision).not.toBe(owner)
  })
})

it('keeps first-user advancement after same-view focus while the startup stream has no anchors', async () => {
  const h = setup()
  const target = { kind: 'message' as const, conversationId: 'c', messageId: 'a' }
  h.controller.request(target, 'route')
  h.snapshot()
  await h.controller.resolve('c', vi.fn())
  h.dispatch(actions.sendingStarted({ streamId: 'run', conversationId: 'c' }))
  h.controller.request(target, 'heimdall')
  await h.controller.resolve('c', vi.fn())
  const message = { ...rows[0], id: 'new-user', parent_id: 'a' }
  for (const action of projectServerEvent({ type: 'user_message_persisted', message } as any, { streamId: 'run', conversationId: 'c' })) h.dispatch(action)
  expect(h.get().conversation.currentPath).toEqual(['root', 'a', 'new-user'])
})
