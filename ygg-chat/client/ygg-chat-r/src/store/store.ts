// store.ts
import { configureStore, createListenerMiddleware } from '@reduxjs/toolkit'
import { chatReducer, chatSliceActions, fetchCustomTools, fetchMcpTools, fetchTools } from '../features/chats'
import { conversationsReducer } from '../features/conversations'
import { ideContextReducer } from '../features/ideContext'
import { default as projectsReducer } from '../features/projects/projectSlice'
import { default as searchReducer } from '../features/search/searchSlice'
import { uiActions, uiReducer } from '../features/ui'
import { usersReducer } from '../features/users'
import { thunkExtraArg } from './thunkExtra'
import { recordTerminalSnapshotLease } from '../features/chats/conversationSnapshotCoordinator'

// Root reducer configuration
const rootReducer = {
  users: usersReducer,
  chat: chatReducer,
  conversations: conversationsReducer,
  search: searchReducer,
  projects: projectsReducer,
  ideContext: ideContextReducer,
  ui: uiReducer,
}

type ListenerState = {
  chat: ReturnType<typeof chatReducer>
  conversations: ReturnType<typeof conversationsReducer>
}

const listenerMiddleware = createListenerMiddleware()

// Provider/client failures can terminate via sendingCompleted without a terminal complete
// event. Preserve any persisted live lineage until the coordinator confirms durability.
listenerMiddleware.startListening({
  actionCreator: chatSliceActions.sendingCompleted,
  effect: (action, api) => {
    const streamId = action.payload?.streamId
    if (!streamId) return
    const state = api.getState() as ListenerState
    const stream = state.chat.streaming.byId[streamId]
    if (!stream?.conversationId) return
    const messageIds = [
      stream.messageId,
      stream.triggerUserMessageId,
      stream.currentBranchAnchorMessageId,
      stream.branchAnchorMessageId,
      stream.lastCompletedMessageId,
      stream.finalMessageId,
      stream.lineage.rootMessageId,
      stream.lineage.originMessageId,
    ]
    if (!messageIds.some(id => id != null)) return
    recordTerminalSnapshotLease({ conversationId: stream.conversationId, streamId, messageIds })
  },
})

listenerMiddleware.startListening({
  actionCreator: chatSliceActions.streamCompleted,
  effect: (action, api) => {
    const payload = action.payload as { streamId?: string; messageId?: string }
    const streamId = payload?.streamId
    const messageId = payload?.messageId

    // Ignore legacy streamCompleted payloads that do not include streamId.
    if (!streamId || messageId == null) return

    const state = api.getState() as ListenerState
    const stream = state.chat.streaming.byId[streamId]
    if (!stream) return

    const conversationId = stream.conversationId
    if (conversationId == null) return

    recordTerminalSnapshotLease({
      conversationId,
      streamId,
      messageIds: [
        messageId,
        stream.triggerUserMessageId,
        stream.currentBranchAnchorMessageId,
        stream.branchAnchorMessageId,
        stream.lastCompletedMessageId,
        stream.finalMessageId,
        stream.lineage.rootMessageId,
        stream.lineage.originMessageId,
      ],
    })

    // Notification requirement remains branch-only; every terminal stream gets a lease.
    if (stream.streamType !== 'branch') return
    const conversation = state.conversations.items.find(c => String(c.id) === String(conversationId))

    api.dispatch(
      uiActions.notificationAdded({
        id: `branch-complete:${streamId}:${String(messageId)}`,
        kind: 'branch_stream_completed',
        title: conversation?.title?.trim() || 'Branch reply finished',
        description: 'A background branch completed. Click to open it.',
        conversationId,
        projectId: conversation?.project_id ?? null,
        messageId,
        createdAt: new Date().toISOString(),
      })
    )
  },
})

// Main store for the app
export const store = configureStore({
  reducer: rootReducer,
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      thunk: {
        extraArgument: thunkExtraArg,
      },
      serializableCheck: {
        ignoredActions: ['persist/PERSIST', 'persist/REHYDRATE'],
      },
    }).prepend(listenerMiddleware.middleware),
  devTools: process.env.NODE_ENV !== 'production',
})

// Initialize custom tools and MCP tools at app startup (before any component renders)
// This ensures tools are available immediately when Chat component mounts
Promise.all([
  store.dispatch(fetchCustomTools() as any),
  store.dispatch(fetchMcpTools() as any),
]).then(() => {
  store.dispatch(fetchTools() as any)
})

// Store factory for testing with preloaded state
export const setupStore = (preloadedState?: Partial<RootState>) => {
  return configureStore({
    reducer: rootReducer,
    preloadedState,
    middleware: getDefaultMiddleware =>
      getDefaultMiddleware({
        thunk: {
          extraArgument: thunkExtraArg,
        },
        serializableCheck: {
          ignoredActions: ['persist/PERSIST', 'persist/REHYDRATE'],
        },
      }),
    devTools: process.env.NODE_ENV !== 'production',
  })
}

// Types
export type RootState = ReturnType<typeof store.getState>
export type AppStore = ReturnType<typeof setupStore>
export type AppDispatch = typeof store.dispatch
