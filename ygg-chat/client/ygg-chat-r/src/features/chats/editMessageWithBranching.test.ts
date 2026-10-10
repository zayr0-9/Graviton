import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
})
vi.mock('./mainChatClient', async importOriginal => ({
  ...await importOriginal<typeof import('./mainChatClient')>(),
  runServerChatLoop: vi.fn(),
}))
vi.mock('./streamRunTracking', () => ({
  createStreamingRun: vi.fn().mockResolvedValue(undefined),
  finishStreamingRun: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../helpers/longTermMemorySettingsStorage', () => ({ loadLongTermMemoryContextEnabled: () => false }))

import type { RootState } from '../../store/store'
import type { Message } from './chatTypes'
import chatReducer, { chatSliceActions } from './chatSlice'
import { editMessageWithBranching, readServerLoopRejection, sendMessage, sendMessageToBranch } from './chatActions'
import { prepareImageFiles } from './imagePreparation'
import { runServerChatLoop } from './mainChatClient'
import { createStreamingRun, finishStreamingRun } from './streamRunTracking'
import { localApi } from '../../utils/api'

const message = (id: string | number, parent: string | number | null = null): Message => ({
  id,
  conversation_id: 'c1',
  role: 'user',
  content: 'Original prompt',
  parent_id: parent,
  children_ids: [],
  created_at: '2026-09-18T00:00:00Z',
  partial: false,
  artifacts: [],
} as Message)

const setup = (live: Message[], cached: Message[]) => {
  const initial = chatReducer(undefined, { type: '@@init' })
  let chat = chatReducer({
    ...initial,
    conversation: { ...initial.conversation, currentConversationId: 'c1', messages: live, currentPath: live.map(m => m.id) },
    providerState: { ...initial.providerState, currentProvider: 'lmstudio' },
  }, chatSliceActions.sendingStarted({ streamId: 'branch-A', conversationId: 'c1' }))
  chat = chatReducer(chat, chatSliceActions.streamChunkReceived({
    streamId: 'branch-A',
    chunk: { type: 'chunk', part: 'tool_call', toolCall: { id: 'tool-1', name: 'read_file', input: { path: 'file.ts' } } },
  }))
  const state = {
    chat,
    ideContext: { selectedFilesForChat: [], workspace: null },
    projects: { selectedProject: null },
    conversations: { items: [{ id: 'c1', storage_mode: 'local' }], systemPrompt: null, convContext: null },
  } as unknown as RootState
  const queryClient = new QueryClient()
  queryClient.setQueryData(['conversations', 'c1', 'messages'], { messages: cached, tree: null })
  const actions: any[] = []
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, () => ({ ...state }), { queryClient, auth: { accessToken: null, userId: 'user' } })
    actions.push(action)
    state.chat = chatReducer(state.chat, action)
    return action
  }
  const fork = (id: string = 'u1') => editMessageWithBranching({
    conversationId: 'c1', originalMessageId: id, newContent: 'Forked prompt', modelOverride: 'test-model', streamId: 'branch-B', think: false,
  })(dispatch, () => ({ ...state }), { queryClient, auth: { accessToken: null, userId: 'user' } })
  return { state, actions, fork, queryClient, dispatch }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(runServerChatLoop).mockResolvedValue({ messageId: null, userMessage: null, providerError: false })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('editMessageWithBranching live source resolution', () => {
  it.each(['send', 'branch', 'edit'] as const)('%s waits for new image preparation before snapshotting and preserves it until accepted', async operation => {
    vi.useRealTimers()
    const { dispatch, state } = setup([message('u1')], [])
    let reader: any
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,aQ=='
      onload?: () => void
      readAsDataURL() { reader = this }
    })
    let save!: (value: any) => void
    const saved = { attachments: [{ id: 'prepared', file_path: '/image.png', sha256: 'hash' }] }
    vi.spyOn(localApi, 'post').mockImplementationOnce(() => new Promise(resolve => { save = resolve }))
      .mockResolvedValue(saved)
    const target = operation === 'send' ? { kind: 'composer' as const } : { kind: 'branch' as const, messageId: 'u1' }
    const preparing = dispatch(prepareImageFiles([{ name: 'a.png', type: 'image/png', size: 1 } as File], target))
    const common = { conversationId: 'c1', think: false, streamId: `image-${operation}` }
    const running = dispatch(operation === 'send'
      ? sendMessage({ ...common, parent: 'u1', repeatNum: 1, input: { content: 'inspect', modelOverride: 'test' } })
      : operation === 'branch'
        ? sendMessageToBranch({ ...common, parentId: 'u1', content: 'inspect', modelOverride: 'test' })
        : editMessageWithBranching({ ...common, originalMessageId: 'u1', newContent: 'inspect', modelOverride: 'test' }))
    expect(runServerChatLoop).not.toHaveBeenCalled()
    reader.onload()
    await vi.waitFor(() => expect(save).toBeTypeOf('function'))
    expect(runServerChatLoop).not.toHaveBeenCalled()
    vi.mocked(runServerChatLoop).mockImplementation(async (params, deps) => {
      expect(params.request.attachmentsBase64).toEqual([expect.objectContaining({ attachmentId: 'prepared', dataUrl: reader.result })])
      expect(state.chat.composition.imageDrafts).toHaveLength(1)
      deps.onUserMessagePersisted?.()
      expect(state.chat.composition.imageDrafts).toEqual([])
      return { messageId: null, userMessage: null, providerError: false }
    })
    save(saved)
    await preparing
    expect((await running).meta.requestStatus).toBe('fulfilled')
  })
  it.each([null, 'older'])('forks a persisted live message with parent %s while A runs tools and the nonempty cache is stale', async parent => {
    const older = message('older')
    const source = message('u1', parent)
    const { fork, state, queryClient } = setup([older, source], [older])
    const branchABefore = state.chat.streaming.byId['branch-A']
    const result = await fork()

    expect(result.type).toBe(editMessageWithBranching.fulfilled.type)
    expect(runServerChatLoop).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'edit', streamId: 'branch-B', path: '/conversations/c1/messages/u1/edit-branch',
      request: expect.objectContaining({ parentId: parent }),
    }), expect.anything())
    expect(state.chat.streaming.byId['branch-A']).toEqual(branchABefore)
    expect(state.chat.streaming.byId['branch-A'].active).toBe(true)
    expect(state.chat.conversation.messages).toContainEqual(source)
    expect(queryClient.getQueryData(['conversations', 'c1', 'messages'])).toEqual({ messages: [older], tree: null })
  })

  it('uses the live parent rather than a stale cached source and matches mixed ID representations', async () => {
    const { fork } = setup([message(42, 'live-parent')], [message('42', 'stale-parent')])
    expect((await fork('42')).type).toBe(editMessageWithBranching.fulfilled.type)
    expect(runServerChatLoop).toHaveBeenCalledWith(expect.objectContaining({
      path: '/conversations/c1/messages/42/edit-branch',
      request: expect.objectContaining({ parentId: 'live-parent' }),
    }), expect.anything())
  })

  it('preserves cache-hydrated image attachments while resolving the source from Redux', async () => {
    const source = message('u1')
    const dataUrl = 'data:image/png;base64,aW1hZ2U='
    const post = vi.spyOn(localApi, 'post').mockResolvedValue({
      attachments: [{ id: 'attachment', file_path: '/image.png', sha256: 'hash', mime_type: 'image/png', size_bytes: 5 }],
    })
    const { fork } = setup([source], [{ ...source, artifacts: [dataUrl] }])
    expect((await fork()).type).toBe(editMessageWithBranching.fulfilled.type)
    expect(post).toHaveBeenCalled()
    expect(runServerChatLoop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userMessageArtifacts: [dataUrl] }))
  })

  it('sends new branch images and consumes only the original draft on acknowledgement', async () => {
    const { fork, dispatch, state } = setup([message('u1')], [])
    const draft = { dataUrl: 'data:image/png;base64,aQ==', name: 'a.png', type: 'image/png', size: 1 }
    const target = { kind: 'branch', messageId: 'u1' } as const
    dispatch(chatSliceActions.imageDraftsAppended({ target, drafts: [draft] }))
    vi.spyOn(localApi, 'post').mockResolvedValue({ attachments: [{ id: 'a', file_path: '/a.png', sha256: 'hash' }] })
    vi.mocked(runServerChatLoop).mockImplementation(async (params, deps) => {
      expect(params.request.attachmentsBase64).toEqual([expect.objectContaining({ attachmentId: 'a', dataUrl: draft.dataUrl })])
      expect(state.chat.composition.imageDrafts).toHaveLength(1)
      dispatch(chatSliceActions.imageDraftRemoved({ target, index: 0 }))
      dispatch(chatSliceActions.imageDraftsAppended({ target, drafts: [{ ...draft }] }))
      deps.onUserMessagePersisted?.()
      expect(state.chat.composition.imageDrafts).toHaveLength(1)
      return { messageId: null, userMessage: null, providerError: false }
    })
    expect((await fork()).type).toBe(editMessageWithBranching.fulfilled.type)
  })

  it('does not consume a newer conversation draft when an old branch is acknowledged', async () => {
    const { fork, dispatch, state } = setup([message('u1')], [])
    const draft = { dataUrl: 'data:image/png;base64,aQ==', name: 'a.png', type: 'image/png', size: 1 }
    const target = { kind: 'branch', messageId: 'u1' } as const
    dispatch(chatSliceActions.imageDraftsAppended({ target, drafts: [draft] }))
    vi.spyOn(localApi, 'post').mockResolvedValue({ attachments: [{ id: 'a', file_path: '/a.png', sha256: 'hash' }] })
    vi.mocked(runServerChatLoop).mockImplementation(async (_params, deps) => {
      dispatch(chatSliceActions.conversationSet('c2'))
      dispatch(chatSliceActions.imageDraftsAppended({ target, drafts: [draft] }))
      deps.onUserMessagePersisted?.()
      expect(state.chat.composition.imageDrafts).toHaveLength(1)
      return { messageId: null, userMessage: null, providerError: false }
    })
    expect((await fork()).type).toBe(editMessageWithBranching.fulfilled.type)
  })

  it('does not resurrect a deleted source from a stale cache or start a stream for a missing message', async () => {
    const { fork, actions, state } = setup([message('older')], [message('older'), message('u1')])
    const result = await fork()
    const failure = readServerLoopRejection(result.payload)
    expect(result.type).toBe(editMessageWithBranching.rejected.type)
    expect(failure?.envelope?.code).toBe('internal_error')
    expect(failure?.envelope?.detail).toContain('Message not found for branch/edit: u1')
    expect(failure?.surfaced).toBe(true)
    expect(createStreamingRun).not.toHaveBeenCalled()
    expect(finishStreamingRun).not.toHaveBeenCalled()
    expect(runServerChatLoop).not.toHaveBeenCalled()
    expect(actions.some(a => a.type === chatSliceActions.sendingStarted.type)).toBe(false)
    expect(state.chat.streaming.byId['branch-A'].active).toBe(true)
  })

  it('rejects source rows belonging to another conversation', async () => {
    const wrongConversation = { ...message('u1'), conversation_id: 'c2' }
    const { fork } = setup([wrongConversation], [wrongConversation])
    expect((await fork()).type).toBe(editMessageWithBranching.rejected.type)
    expect(runServerChatLoop).not.toHaveBeenCalled()
  })

  it('classifies branch setup errors as preflight failures, not interrupted replies', async () => {
    const { fork, queryClient } = setup([message('u1')], [])
    vi.spyOn(queryClient, 'getQueryData').mockImplementation(key => {
      if (key[0] === 'models') throw new TypeError('Invalid model configuration')
      return undefined
    })
    const result = await fork()
    expect(readServerLoopRejection(result.payload)?.envelope?.code).toBe('internal_error')
    expect(runServerChatLoop).not.toHaveBeenCalled()
  })

  it('still classifies untagged failures after starting the server reader as stream interruptions', async () => {
    vi.mocked(runServerChatLoop).mockRejectedValue(new Error('reader closed'))
    const { fork } = setup([message('u1')], [])
    const result = await fork()
    expect(readServerLoopRejection(result.payload)?.envelope?.code).toBe('stream_interrupted')
  })
})
