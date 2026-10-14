import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const memory = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  } })
})

vi.mock('../../helpers/serverLoopSettings', () => ({ isResumableRunsEnabled: () => true }))
vi.mock('./mainChatClient', async original => ({
  ...await original<typeof import('./mainChatClient')>(), runServerReattach: vi.fn(),
}))

import chatReducer, { chatSliceActions as actions } from './chatSlice'
import { adoptWatchContinuation } from './watchContinuation'
import { listInflightStreams, updateInflightStreamCursor } from './inflightStreams'
import { applyStreamProjectionPolicy, projectServerEvent, type ServerStreamEvent } from './sseProjection'
import { selectCurrentViewStream, selectDisplayMessagesFor } from './chatSelectors'
import { chatSelectionCommitted, chatSelectionRequested } from './chatSelection'
import type { ChatState, Message } from './chatTypes'
import type { RootState } from '../../store/store'

beforeEach(() => localStorage.clear())

const row = (id: string, parent_id: string | null, role: Message['role'] = 'assistant'): Message => ({
  id, parent_id, role, conversation_id: 'chat', content: id, content_plain_text: id,
  children_ids: [], created_at: '2026-10-14T00:00:00Z', model_name: 'test', partial: false,
  pastedContext: [], artifacts: [],
})
const initialRows = [row('root', null, 'user'), row('tail', 'root'), row('sibling', 'tail')]

function setup(path = ['root', 'tail'], lineageId: string | null = 'branch') {
  let state = structuredClone(chatReducer(undefined, { type: 'init' }))
  state.conversation.currentConversationId = 'chat'
  state.conversation.messages = initialRows
  state.conversation.currentPath = path
  state.conversation.currentLineageId = lineageId
  state.composition.input.content = 'unsent draft'
  state.composition.imageDrafts = [{ id: 'image', name: 'draft', dataUrl: 'data:image/png;base64,AAA' } as any]
  state.selection.status = 'ready'
  const dispatch = (action: any) => { state = chatReducer(state, action) }
  adoptWatchContinuation({ handle: 'watch', state: 'triggered', kind: 'process_exit', conversationId: 'chat',
    lineageId: 'branch', messageId: 'root', projectId: null, completedAt: 'now', delivery: 'restarted',
    streamId: 'successor', parentId: 'tail' }, () => false)
  const attach = () => {
    const record = listInflightStreams('chat')[0]
    dispatch(actions.sendingStarted({ streamId: record.streamId, conversationId: record.conversationId,
      streamType: record.streamType, updatePath: record.updatePath, watchContinuation: record.watchContinuation,
      preserveDrafts: true, selectionRevision: -1,
      lineage: { rootMessageId: record.parentMessageId ?? undefined,
        lineageId: record.watchContinuation?.lineageId, lineageIdConfirmed: true } }))
  }
  attach()
  const emit = (event: ServerStreamEvent) => {
    const record = listInflightStreams('chat')[0]
    for (const action of projectServerEvent(event, { streamId: record.streamId, conversationId: record.conversationId })) {
      dispatch(applyStreamProjectionPolicy(action, { streamId: record.streamId,
        streamType: record.streamType, updatePath: record.updatePath ?? false }))
    }
  }
  const select = (nextPath: string[], nextLineage: string | null = null) => {
    const requestId = `selection-${state.selection.revision + 1}`
    dispatch(chatSelectionRequested({ requestId, target: { kind: 'message', conversationId: 'chat',
      messageId: nextPath.at(-1)! }, source: 'heimdall' }))
    dispatch(chatSelectionCommitted({ requestId, conversationId: 'chat', lineageId: nextLineage,
      path: nextPath, focus: nextPath.at(-1)! }))
  }
  return { get: () => state, dispatch, emit, attach, select,
    mutate: (change: (draft: ChatState) => void) => { state = structuredClone(state); change(state) },
    displayed: () => selectDisplayMessagesFor(state.conversation.messages, state.conversation.currentPath).map(m => m.id) }
}

const userEvent = (): ServerStreamEvent => ({ type: 'user_message_persisted', message: row('watch-user', 'tail', 'user'), lineageId: 'branch' } as ServerStreamEvent)
const answerEvent = (): ServerStreamEvent => ({ type: 'assistant_message_persisted', message: row('answer', 'watch-user'), lineageId: 'branch' } as ServerStreamEvent)
const completeEvent = (): ServerStreamEvent => ({ type: 'complete', message: row('answer', 'watch-user'), lineageId: 'branch' } as ServerStreamEvent)

describe('watcher continuation transcript following', () => {
  it.each(['branch', null])('follows the viewed tail through persistence and completion (lineage %s)', lineage => {
    const h = setup(undefined, lineage)
    const drafts = h.get().composition.imageDrafts
    // started.parentId is the new user ID, not the original continuation parent.
    h.emit({ type: 'started', parentId: 'watch-user', lineageId: 'branch' } as ServerStreamEvent)
    h.emit(userEvent())
    expect(h.displayed()).toEqual(['root', 'tail', 'watch-user'])
    h.emit({ type: 'chunk', part: 'text', delta: 'live answer' })
    expect(selectCurrentViewStream({ chat: h.get() } as RootState)?.buffer).toBe('live answer')
    h.emit(answerEvent())
    h.emit(completeEvent())
    expect(h.displayed()).toEqual(['root', 'tail', 'watch-user', 'answer'])
    expect(selectCurrentViewStream({ chat: h.get() } as RootState)).toBeNull()
    expect(h.get().composition.input.content).toBe('unsent draft')
    expect(h.get().composition.imageDrafts).toEqual(drafts)
    expect(h.get().streaming.primaryStreamId).toBeNull()
  })

  it.each([
    { path: ['root', 'tail'], lineage: 'other' },
    { path: ['root', 'tail', 'sibling'], lineage: null },
    { path: ['root', 'tail', 'sibling'], lineage: 'branch' },
    { path: ['root'], lineage: null },
    { path: ['root'], lineage: 'branch' },
    { path: [], lineage: 'branch' },
  ])('does not steal a sibling, historical, or unresolved selection: %j', ({ path, lineage }) => {
    const h = setup(path, lineage)
    // Even matching revisions must not bypass watcher-specific branch proof.
    h.mutate(state => { state.streaming.byId.successor.selectionRevision = state.selection.revision })
    h.emit({ type: 'started', parentId: 'watch-user', lineageId: 'branch' } as ServerStreamEvent)
    h.emit(userEvent())
    h.emit(answerEvent())
    h.emit(completeEvent())
    expect(h.get().conversation.currentPath).toEqual(path)
    expect(h.get().conversation.currentLineageId).toBe(lineage)
    expect(h.get().conversation.messages.some(m => m.id === 'answer')).toBe(true)
  })

  it.each(['pending', 'error'] as const)('does not override %s navigation', status => {
    const h = setup()
    h.mutate(state => { state.selection.status = status })
    h.emit(userEvent())
    h.emit(completeEvent())
    expect(h.displayed()).toEqual(['root', 'tail'])
  })

  it('does not modify a different conversation', () => {
    const h = setup()
    h.dispatch(actions.conversationSet('other-chat'))
    h.emit(userEvent())
    h.emit(completeEvent())
    expect(h.get().conversation.currentConversationId).toBe('other-chat')
    expect(h.get().conversation.currentPath).toEqual([])
  })

  it('rechecks navigation between events and resumes only on the actual continuation', () => {
    const h = setup()
    h.emit(userEvent())
    h.select(['root', 'tail', 'sibling'])
    h.emit(answerEvent())
    expect(h.displayed()).toEqual(['root', 'tail', 'sibling'])
    h.select(['root', 'tail', 'watch-user', 'answer'])
    h.emit({ type: 'queued_user_message_persisted', message: row('queued', 'answer', 'user') } as ServerStreamEvent)
    expect(h.displayed().at(-1)).toBe('queued')
    h.emit({ type: 'operation_mode_changed', mode: 'execute', message: row('mode', 'queued', 'user') } as ServerStreamEvent)
    expect(h.displayed().at(-1)).toBe('mode')
    h.emit({ type: 'complete', message: row('final', 'mode'), lineageId: 'branch' } as ServerStreamEvent)
    expect(h.displayed().at(-1)).toBe('final')
  })

  it('survives cursor reattachment without replaying started and catches up across known context rows', () => {
    const h = setup(undefined, null)
    h.emit(userEvent())
    h.dispatch(actions.messageAdded(row('context', 'watch-user', 'system')))
    updateInflightStreamCursor('successor', 42)
    h.attach()
    expect(listInflightStreams()[0].lastSeq).toBe(42)
    h.emit({ type: 'assistant_message_persisted', message: row('answer', 'context'), lineageId: 'branch' } as ServerStreamEvent)
    expect(h.displayed()).toEqual(['root', 'tail', 'watch-user', 'context', 'answer'])
  })

  it('advances on terminal-only replay even after terminal anchors have moved', () => {
    const h = setup(undefined, null)
    h.dispatch(actions.messageAdded(row('watch-user', 'tail', 'user')))
    h.dispatch(actions.messageAdded(row('answer', 'watch-user')))
    h.dispatch(actions.streamCompleted({ streamId: 'successor', messageId: 'answer', updatePath: true }))
    expect(h.displayed()).toEqual(['root', 'tail', 'watch-user', 'answer'])
  })

  it('fails closed on incomplete or cyclic ancestry', () => {
    const h = setup()
    h.emit({ type: 'user_message_persisted', message: row('orphan', 'missing'), lineageId: 'branch' } as ServerStreamEvent)
    expect(h.displayed()).toEqual(['root', 'tail'])
    h.dispatch(actions.messageAdded(row('cycle-a', 'cycle-b')))
    h.dispatch(actions.messageAdded(row('cycle-b', 'cycle-a')))
    h.dispatch(actions.messageBranchCreated({ newMessage: row('cycle-a', 'cycle-b'), streamId: 'successor', updatePath: true }))
    expect(h.displayed()).toEqual(['root', 'tail'])
  })

  it.each(['missing', 'cycle'] as const)('rejects %s ancestry above the watcher parent', problem => {
    const h = setup()
    h.mutate(state => {
      state.conversation.messages.find(message => message.id === 'root')!.parent_id = problem === 'cycle' ? 'tail' : 'missing'
    })
    h.emit(userEvent())
    expect(h.displayed()).toEqual(['root', 'tail'])
  })

  it('does not guess ownership from the registration message when the actual parent is absent', () => {
    const h = setup()
    h.mutate(state => { state.streaming.byId.successor.watchContinuation!.parentMessageId = null })
    h.emit(userEvent())
    h.emit(completeEvent())
    expect(h.displayed()).toEqual(['root', 'tail'])
  })

  it('does not relax ordinary parallel-stream isolation', () => {
    const h = setup()
    h.dispatch(actions.sendingStarted({ streamId: 'parallel', conversationId: 'chat', streamType: 'branch', updatePath: false }))
    const message = row('parallel-user', 'tail', 'user')
    h.dispatch(actions.messageAdded(message))
    h.dispatch(actions.messageBranchCreated({ newMessage: message, streamId: 'parallel', updatePath: true }))
    expect(h.displayed()).toEqual(['root', 'tail'])
  })
})

describe('watcher reattachment wiring', () => {
  it('carries adoption ownership through the real resume thunk and refreshes the tree', async () => {
    const { resumeInFlightStreams } = await import('./chatActions')
    const { runServerReattach } = await import('./mainChatClient')
    const h = setup(undefined, null)
    updateInflightStreamCursor('successor', 42)
    vi.mocked(runServerReattach).mockImplementationOnce(async (request, deps) => {
      expect(request.fromSeq).toBe(42)
      expect(h.get().streaming.byId.successor.watchContinuation).toEqual({ lineageId: 'branch', parentMessageId: 'tail' })
      for (const event of [userEvent(), answerEvent(), completeEvent()]) {
        for (const action of projectServerEvent(event, { streamId: request.streamId, conversationId: request.conversationId })) {
          deps.dispatch(action)
        }
        deps.onMessagePersisted?.()
      }
      return { gone: false, terminal: true, messageId: 'answer', userMessage: null, providerError: false }
    })
    const result = await resumeInFlightStreams({ conversationId: 'chat', streamId: 'successor' })(
      h.dispatch as any, () => ({ chat: h.get() }) as RootState,
      { auth: { accessToken: null, userId: null }, queryClient: null } as any,
    )
    expect(result.type).toBe(resumeInFlightStreams.fulfilled.type)
    expect(runServerReattach).toHaveBeenCalledTimes(1)
    expect(h.displayed()).toEqual(['root', 'tail', 'watch-user', 'answer'])
    expect(JSON.stringify(h.get().heimdall.treeData)).toContain('answer')
    expect(listInflightStreams()).toEqual([])
    expect(h.get().composition.input.content).toBe('unsent draft')
  })
})
