import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The renderer suite runs without a DOM. Drive the hook's state/effect lifecycle
// explicitly while retaining the real snapshot coordinator, selection controller,
// and Redux reducer below.
const hooks = vi.hoisted(() => ({
  cells: [] as any[],
  cursor: 0,
  effects: [] as Array<() => void>,
}))
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
})
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  const changed = (previous: unknown[] | undefined, next: unknown[]) =>
    !previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]))
  return {
    ...actual,
    useState: (initial: any) => {
      const index = hooks.cursor++
      const cells = hooks.cells
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (value: any) => {
        cells[index] = typeof value === 'function' ? value(cells[index]) : value
      }]
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++
      return hooks.cells[index] ?? (hooks.cells[index] = { current: initial })
    },
    useMemo: (factory: () => unknown, dependencies: unknown[]) => {
      const index = hooks.cursor++
      const previous = hooks.cells[index]
      if (changed(previous?.dependencies, dependencies)) hooks.cells[index] = { value: factory(), dependencies }
      return hooks.cells[index].value
    },
    useCallback: (callback: any, dependencies: unknown[]) => {
      const index = hooks.cursor++
      const previous = hooks.cells[index]
      if (changed(previous?.dependencies, dependencies)) hooks.cells[index] = { callback, dependencies }
      return hooks.cells[index].callback
    },
    useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
      const index = hooks.cursor++
      const previous = hooks.cells[index]
      if (!changed(previous?.dependencies, dependencies)) return
      const cell = { dependencies, effect, cleanup: undefined as void | (() => void) }
      hooks.cells[index] = cell
      hooks.effects.push(() => {
        previous?.cleanup?.()
        cell.cleanup = effect()
      })
    },
  }
})
vi.mock('@tanstack/react-query', async original => {
  const actual = await original<typeof import('@tanstack/react-query')>()
  return { ...actual, useQueryClient: () => queryClient }
})
vi.mock('react-redux', () => ({ useStore: () => reduxStore }))
vi.mock('./redux', () => ({
  useAppDispatch: () => dispatch,
  useAppSelector: (selector: (state: any) => unknown) => selector(reduxStore.getState()),
}))
vi.mock('./useAuth', () => ({ useAuth: () => ({ accessToken: null }) }))
vi.mock('../features/chats/conversationMessagesApi', () => ({ fetchConversationMessagesTree: vi.fn() }))

import { useConversationSnapshotCoordinator } from './useConversationSnapshotCoordinator'
import reducer from '../features/chats/chatSlice'
import { createChatSelectionController } from '../features/chats/chatSelectionController'
import { clearConversationSnapshotCoordinatorForTests } from '../features/chats/conversationSnapshotCoordinator'
import { fetchConversationMessagesTree, type ConversationMessagesTreeData } from '../features/chats/conversationMessagesApi'
import type { Message } from '../features/chats/chatTypes'

let queryClient: QueryClient
let chat: ReturnType<typeof reducer>
const reduxStore = { getState: () => ({ chat }) }
const dispatch = (action: any) => { chat = reducer(chat, action) }
let requestNumber = 0
const selection = createChatSelectionController({
  getState: () => chat, dispatch, loadLineage: async () => ({}),
  createRequestId: () => `request-${++requestNumber}`,
})

function render(conversationId = 'c', storageMode: 'local' | 'cloud' = 'local') {
  hooks.cursor = 0
  const result = useConversationSnapshotCoordinator(conversationId, storageMode)
  hooks.effects.splice(0).forEach(effect => effect())
  return result
}

// Same readiness decision as Chat.tsx, exercised against real selection state.
async function resolveSelection(result: ReturnType<typeof render>, conversationId = 'c') {
  if (result.error && result.isCurrentError() && !result.isFetching && !result.acceptedConversationId) {
    selection.snapshotFailed(conversationId, chat.selection.requestId)
  } else {
    await selection.resolve(result.acceptedConversationId, result.refresh)
  }
}

function deferredSnapshot() {
  let resolve!: (data: ConversationMessagesTreeData) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ConversationMessagesTreeData>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const empty: ConversationMessagesTreeData = { messages: [], tree: null }

beforeEach(() => {
  selection.cancel()
  clearConversationSnapshotCoordinatorForTests()
  hooks.cells = []
  hooks.cursor = 0
  hooks.effects = []
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  chat = reducer(undefined, { type: 'init' })
  requestNumber = 0
  vi.mocked(fetchConversationMessagesTree).mockReset()
})

describe('snapshot readiness for primary chat selection', () => {
  it('keeps the replacement loading and selects a new empty chat after a wrapped abort', async () => {
    const replacement = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockImplementationOnce((_id, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('Local API error (messages/tree): signal is aborted without reason'))
        }, { once: true })
      }))
      .mockImplementationOnce(() => replacement.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'navigation')
    const initial = render() // Route-entry effect starts the first request.
    const refreshing = initial.refresh()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const pending = render()
    expect(pending.isFetching).toBe(true)
    expect(pending.error).toBeNull()
    await resolveSelection(pending)
    expect(chat.selection.status).toBe('pending')

    replacement.resolve(empty)
    await refreshing
    const ready = render()
    expect(ready).toMatchObject({ isFetching: false, error: null, acceptedConversationId: 'c', isFetched: true })
    await resolveSelection(ready)
    expect(chat.selection.status).toBe('ready')
    expect(chat.conversation.currentPath).toEqual([])
  })

  it('ignores an old failure after the replacement succeeds and keeps branch selection usable', async () => {
    const old = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ messages: [
        { id: 'root', parent_id: null }, { id: 'a', parent_id: 'root' }, { id: 'b', parent_id: 'root' },
      ].map(row => ({ ...row, conversation_id: 'c', role: 'user', created_at: '2026-01-01', children_ids: [] })) as Message[], tree: null })
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'navigation')
    await render().refresh()
    old.reject(new Error('Late transport failure'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(render().error).toBeNull()
    await resolveSelection(render())
    expect(chat.selection.status).toBe('ready')

    selection.request({ kind: 'message', conversationId: 'c', messageId: 'b', path: ['root', 'b'] }, 'heimdall')
    await resolveSelection(render())
    expect(chat.selection.status).toBe('ready')
    expect(chat.conversation.currentPath).toEqual(['root', 'b'])
  })

  it('surfaces a genuine current failure and recovers through the existing retry transaction', async () => {
    const failure = new Error('Database unavailable')
    vi.mocked(fetchConversationMessagesTree).mockRejectedValueOnce(failure).mockResolvedValueOnce(empty)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'navigation')
    render()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(render().error).toBe(failure)
    await resolveSelection(render())
    expect(chat.selection.status).toBe('error')

    await render().refresh()
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'retry')
    await resolveSelection(render())
    expect(render().error).toBeNull()
    expect(chat.selection.status).toBe('ready')
  })

  it('does not expose A\'s error to the readiness consumer on the first B render', async () => {
    const next = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockRejectedValueOnce(new Error('A is unavailable'))
      .mockImplementationOnce(() => next.promise)
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'navigation')
    render('a')
    await vi.waitFor(() => expect(render('a').error).not.toBeNull())
    await resolveSelection(render('a'), 'a')
    expect(chat.selection.status).toBe('error')

    selection.request({ kind: 'conversation', conversationId: 'b' }, 'navigation')
    const firstBRender = render('b')
    expect(firstBRender.error).toBeNull()
    await resolveSelection(firstBRender, 'b')
    expect(chat.selection.status).toBe('pending')
    next.resolve(empty)
    await vi.waitFor(() => expect(render('b').acceptedConversationId).toBe('b'))
    await resolveSelection(render('b'), 'b')
    expect(chat.selection.status).toBe('ready')
  })

  it('surfaces a genuine replacement failure after suppressing the older request', async () => {
    const old = deferredSnapshot()
    const replacement = deferredSnapshot()
    const failure = new Error('Replacement failed')
    vi.mocked(fetchConversationMessagesTree)
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => replacement.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'navigation')
    const refreshing = render().refresh()
    old.reject(new Error('Old transport failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(render()).toMatchObject({ isFetching: true, error: null })
    replacement.reject(failure)
    await refreshing
    expect(render()).toMatchObject({ isFetching: false, error: failure })
    await resolveSelection(render())
    expect(chat.selection.status).toBe('error')
  })

  it('invalidates an unmounted same-chat request before a fresh hook accepts its snapshot', async () => {
    const old = deferredSnapshot()
    const next = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => next.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'navigation')
    render()
    const oldCells = hooks.cells
    oldCells.forEach(cell => cell?.cleanup?.())
    hooks.cells = []
    render()
    next.resolve(empty)
    await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
    const oldState = oldCells.slice(0, 5)
    old.reject(new Error('Unmounted transport failed'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(oldCells.slice(0, 5)).toEqual(oldState)
    expect(render().error).toBeNull()
    await resolveSelection(render())
    expect(chat.selection.status).toBe('ready')
  })

  it('ignores a retained refresh callback from the previous conversation', async () => {
    const first = deferredSnapshot()
    const next = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => next.promise)
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'navigation')
    const previous = render('a')
    selection.request({ kind: 'conversation', conversationId: 'b' }, 'navigation')
    render('b')
    await expect(previous.refresh()).resolves.toBeUndefined()
    expect(fetchConversationMessagesTree).toHaveBeenCalledTimes(2)
    expect(render('b').isFetching).toBe(true)
    next.resolve(empty)
    await vi.waitFor(() => expect(render('b').acceptedConversationId).toBe('b'))
    first.resolve(empty)
    await Promise.resolve()
    await Promise.resolve()
    await resolveSelection(render('b'), 'b')
    expect(chat.selection.status).toBe('ready')
  })

  it('does not let an earlier A visit clear loading on a later A visit', async () => {
    const oldA = deferredSnapshot()
    const latestA = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockImplementationOnce(() => oldA.promise)
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(() => latestA.promise)
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'navigation')
    render('a')
    selection.request({ kind: 'conversation', conversationId: 'b' }, 'navigation')
    render('b')
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'navigation')
    render('a')
    oldA.resolve(empty)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(render('a')).toMatchObject({ isFetching: true, error: null, acceptedConversationId: null })
    latestA.resolve(empty)
    await vi.waitFor(() => expect(render('a').acceptedConversationId).toBe('a'))
    await resolveSelection(render('a'), 'a')
    expect(chat.selection.status).toBe('ready')
  })
})


describe('selection recovery and retained refresh ownership', () => {
  it('recovers the same failed selection when a later snapshot succeeds', async () => {
    vi.mocked(fetchConversationMessagesTree)
      .mockRejectedValueOnce(new Error('Temporary load failure'))
      .mockResolvedValueOnce(empty)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    await vi.waitFor(() => expect(render().error).not.toBeNull())
    await resolveSelection(render())
    const failedSelection = chat.selection
    expect(failedSelection.status).toBe('error')

    await render().refresh()
    await resolveSelection(render())
    expect(chat.selection).toMatchObject({
      status: 'ready', error: null, requestId: failedSelection.requestId,
      revision: failedSelection.revision, fallbackRevision: failedSelection.fallbackRevision,
    })
  })

  it('does not allow an unmounted refresh callback to supersede the replacement mount', async () => {
    const next = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(() => next.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    const previous = render()
    await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
    hooks.cells.forEach(cell => cell?.cleanup?.())
    hooks.cells = []
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    await expect(previous.refresh()).resolves.toBeUndefined()
    expect(fetchConversationMessagesTree).toHaveBeenCalledTimes(2)
    next.resolve(empty)
    await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
    await resolveSelection(render())
    expect(chat.selection.status).toBe('ready')
  })

  it('does not revive a retained first-visit callback after A -> B -> A', async () => {
    const latest = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(() => latest.promise)
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'route')
    const previous = render('a')
    await vi.waitFor(() => expect(render('a').acceptedConversationId).toBe('a'))
    selection.request({ kind: 'conversation', conversationId: 'b' }, 'route')
    render('b')
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'route')
    render('a')
    await expect(previous.refresh()).resolves.toBeUndefined()
    expect(fetchConversationMessagesTree).toHaveBeenCalledTimes(3)
    latest.resolve(empty)
    await vi.waitFor(() => expect(render('a').acceptedConversationId).toBe('a'))
    await resolveSelection(render('a'), 'a')
    expect(chat.selection.status).toBe('ready')
  })

  it('reloads a failed same-chat history visit instead of reusing its error', async () => {
    const next = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockImplementationOnce(() => next.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    await vi.waitFor(() => expect(render().error).not.toBeNull())
    await resolveSelection(render())
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    const firstReentry = render()
    await resolveSelection(firstReentry)
    expect(fetchConversationMessagesTree).toHaveBeenCalledTimes(2)
    expect(chat.selection.status).toBe('pending')
    next.resolve(empty)
    await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
    await resolveSelection(render())
    expect(chat.selection.status).toBe('ready')
  })
})


describe('replacement and route commit boundaries', () => {
  it('Retry recovers through a replacement even when its first refresh is superseded', async () => {
    const retry = deferredSnapshot()
    const replacement = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementationOnce(() => retry.promise)
      .mockImplementationOnce(() => replacement.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    await vi.waitFor(() => expect(render().error).not.toBeNull())
    await resolveSelection(render())
    selection.request(chat.selection.target!, 'retry')
    render()
    const replacing = render().refresh()
    retry.reject(new Error('Wrapped cancellation'))
    await Promise.resolve()
    await Promise.resolve()
    expect(render().error).toBeNull()
    replacement.resolve(empty)
    await replacing
    await resolveSelection(render())
    expect(chat.selection.status).toBe('ready')
  })

  it('does not apply a rendered error after an earlier effect starts a new refresh', async () => {
    const next = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree)
      .mockRejectedValueOnce(new Error('First context failed'))
      .mockImplementationOnce(() => next.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    await vi.waitFor(() => expect(render().error).not.toBeNull())
    // React effects capture this render, while the hook effect has already started
    // another request by the time Chat consumes it.
    const staleRender = render('c', 'cloud')
    expect(staleRender.error).not.toBeNull()
    expect(staleRender.isCurrentError()).toBe(false)
    await resolveSelection(staleRender)
    expect(chat.selection.status).toBe('pending')
    next.resolve(empty)
    await vi.waitFor(() => expect(render('c', 'cloud').acceptedConversationId).toBe('c'))
    await resolveSelection(render('c', 'cloud'))
    expect(chat.selection.status).toBe('ready')
  })

  it('does not commit a snapshot after unmount, even while Redux still selects that conversation', async () => {
    const old = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree).mockImplementationOnce(() => old.promise)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    hooks.cells.forEach(cell => cell?.cleanup?.())
    old.resolve(empty)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(chat.conversation.snapshotConversationId).toBeNull()
    expect(queryClient.getQueryData(['conversations', 'c', 'messages'])).toBeUndefined()
  })

  it('does not trust A acceptance after batched A -> B -> A intents clear Redux authority', async () => {
    const next = deferredSnapshot()
    vi.mocked(fetchConversationMessagesTree).mockResolvedValueOnce(empty).mockImplementationOnce(() => next.promise)
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'route')
    render('a')
    await vi.waitFor(() => expect(render('a').acceptedConversationId).toBe('a'))
    await resolveSelection(render('a'), 'a')
    selection.request({ kind: 'conversation', conversationId: 'b' }, 'route')
    selection.request({ kind: 'conversation', conversationId: 'a' }, 'route')
    expect(render('a').acceptedConversationId).toBeNull()
    expect(fetchConversationMessagesTree).toHaveBeenCalledTimes(2)
    next.resolve(empty)
    await vi.waitFor(() => expect(render('a').acceptedConversationId).toBe('a'))
    await resolveSelection(render('a'), 'a')
    expect(chat.selection.status).toBe('ready')
  })

  it('same-view focus does not refetch or replay navigation on ordinary refresh', async () => {
    vi.mocked(fetchConversationMessagesTree).mockResolvedValue(empty)
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
    await resolveSelection(render())
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'heimdall')
    await resolveSelection(render())
    expect(fetchConversationMessagesTree).toHaveBeenCalledTimes(1)
    const ready = chat.selection
    await render().refresh()
    await resolveSelection(render())
    expect(chat.selection).toBe(ready)
  })

  it('an unsolicited transport AbortError is retryable, not permanently pending', async () => {
    vi.mocked(fetchConversationMessagesTree).mockRejectedValue(new DOMException('Transport aborted', 'AbortError'))
    selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
    render()
    await vi.waitFor(() => expect(render().error).not.toBeNull())
    await resolveSelection(render())
    expect(chat.selection.status).toBe('error')
  })
})


it('restarts the snapshot after StrictMode cleanup/setup without accepting the first mount attempt', async () => {
  const first = deferredSnapshot()
  const second = deferredSnapshot()
  vi.mocked(fetchConversationMessagesTree).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
  render()
  const effects = hooks.cells.filter(cell => cell?.effect)
  effects.forEach(cell => cell.cleanup?.())
  effects.forEach(cell => { cell.cleanup = cell.effect() })
  expect(fetchConversationMessagesTree).toHaveBeenCalledTimes(2)
  first.resolve(empty)
  await Promise.resolve()
  await Promise.resolve()
  expect(render().acceptedConversationId).toBeNull()
  second.resolve(empty)
  await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
  await resolveSelection(render())
  expect(chat.selection.status).toBe('ready')
})


it('waits for the replacement snapshot before falling back from a missing message target', async () => {
  const first = deferredSnapshot()
  const replacement = deferredSnapshot()
  vi.mocked(fetchConversationMessagesTree)
    .mockResolvedValueOnce(empty)
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => replacement.promise)
  selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
  render()
  await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
  await resolveSelection(render())
  selection.request({ kind: 'message', conversationId: 'c', messageId: 'new' }, 'retry')
  const resolving = resolveSelection(render()) // Resolver requests the missing message.
  const replacing = render().refresh()
  first.reject(new Error('Wrapped abort'))
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(chat.selection.status).toBe('pending')
  replacement.resolve({ messages: [{ id: 'new', conversation_id: 'c', parent_id: null, children_ids: [], created_at: '2026-01-01' } as unknown as Message], tree: null })
  await replacing
  await resolving
  expect(chat.selection).toMatchObject({ status: 'ready', error: null })
  expect(chat.conversation.currentPath).toEqual(['new'])
  expect(chat.conversation.focusedChatMessageId).toBe('new')
})


it('a failed background refresh does not disable an already resolved conversation', async () => {
  vi.mocked(fetchConversationMessagesTree).mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error('Temporary refresh failure'))
  selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
  render()
  await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
  await resolveSelection(render())
  await render().refresh()
  await resolveSelection(render())
  expect(chat.selection).toMatchObject({ status: 'ready', error: null })
})

it('repeated failed Retry remains actionable and a later Retry succeeds', async () => {
  vi.mocked(fetchConversationMessagesTree)
    .mockRejectedValueOnce(new Error('First failure'))
    .mockRejectedValueOnce(new Error('Second failure'))
    .mockResolvedValueOnce(empty)
  selection.request({ kind: 'conversation', conversationId: 'c' }, 'route')
  render()
  await vi.waitFor(() => expect(render().error).not.toBeNull())
  await resolveSelection(render())
  selection.request(chat.selection.target!, 'retry')
  render()
  await vi.waitFor(() => expect(render().error?.message).toBe('Second failure'))
  await resolveSelection(render())
  expect(chat.selection.status).toBe('error')
  expect(render().isFetching).toBe(false)
  selection.request(chat.selection.target!, 'retry')
  render()
  await vi.waitFor(() => expect(render().acceptedConversationId).toBe('c'))
  await resolveSelection(render())
  expect(chat.selection).toMatchObject({ status: 'ready', error: null })
})
