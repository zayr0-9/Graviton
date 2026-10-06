import { createSlice, type Middleware, type PayloadAction } from '@reduxjs/toolkit'
import type { ChatState, Message, StreamState } from './chatTypes'

export interface AgentPreviewEntry {
  key: string
  message?: Message
  /** Reduced current-turn events, not a second append-only token log. */
  stream?: StreamState
  /** Events already covered by the latest persisted row; later deltas may override it. */
  persistedEvents?: StreamState['events']
}

export interface AgentRunPreview {
  streamId: string
  stream: StreamState
  projectId: string | null
  conversationTitle: string | null
  completedAt: string | null
  entries: AgentPreviewEntry[]
  turn: number
  liveKey: string
  /** A replay starting mid-run cannot reconstruct earlier turns after a reload. */
  partial: boolean
}

export interface AgentRunPreviewState {
  byStreamId: Record<string, AgentRunPreview>
  latestByFork: Record<string, string>
}

const initialState: AgentRunPreviewState = { byStreamId: {}, latestByFork: {} }
export const previewForkKey = (streamId: string, stream: StreamState): string =>
  stream.conversationId && stream.lineage.lineageId && stream.lineage.lineageIdConfirmed
    ? JSON.stringify(['fork', String(stream.conversationId), String(stream.lineage.lineageId)])
    : JSON.stringify(['run', streamId])

const hasOutput = (stream: StreamState) => Boolean(stream.events.length || stream.buffer || stream.thinkingBuffer)

/** Newest start wins, not newest completion. Keep older simultaneous runs only while active. */
function reconcileRetention(state: AgentRunPreviewState) {
  const latest: Record<string, string> = {}
  for (const run of Object.values(state.byStreamId)) {
    const key = previewForkKey(run.streamId, run.stream)
    const previous = state.byStreamId[latest[key]]
    if (!previous || run.stream.createdAt > previous.stream.createdAt ||
        (run.stream.createdAt === previous.stream.createdAt && run.streamId > previous.streamId)) {
      latest[key] = run.streamId
    }
  }
  state.latestByFork = latest
  for (const run of Object.values(state.byStreamId)) {
    if (!run.stream.active && latest[previewForkKey(run.streamId, run.stream)] !== run.streamId) {
      delete state.byStreamId[run.streamId]
    }
  }
}

const slice = createSlice({
  name: 'agentRunPreviews',
  initialState,
  reducers: {
    cleared: () => initialState,
    synchronized: (state, action: PayloadAction<{
      streamId: string; stream: StreamState; start: boolean; boundary: boolean;
      projectId: string | null; conversationTitle: string | null; now: string
    }>) => {
      const { streamId, stream, start, boundary, projectId, conversationTitle, now } = action.payload
      let run = state.byStreamId[streamId]
      if (!run) {
        // Never resurrect a superseded/pruned run on late terminal events.
        if (!start) return
        run = state.byStreamId[streamId] = {
          streamId, stream, projectId, conversationTitle, completedAt: null,
          entries: [], turn: 0, liveKey: `${streamId}:turn:0`, partial: true,
        }
      }
      const identityChanged = previewForkKey(streamId, run.stream) !== previewForkKey(streamId, stream)
      const ended = run.stream.active && !stream.active
      if (boundary && run.entries.some(entry => entry.key === run.liveKey)) {
        run.turn += 1
        run.liveKey = `${streamId}:turn:${run.turn}`
      }
      run.stream = stream
      run.projectId = projectId ?? run.projectId
      run.conversationTitle = conversationTitle ?? run.conversationTitle
      if (!stream.active) run.completedAt ??= now
      if (hasOutput(stream)) {
        const entry = run.entries.find(candidate => candidate.key === run.liveKey)
        if (entry) entry.stream = stream
        else run.entries.push({ key: run.liveKey, stream })
      }
      if (start || identityChanged || ended) reconcileRetention(state)
    },
    messageReceived: (state, action: PayloadAction<{ streamId: string; message: Message }>) => {
      const run = state.byStreamId[action.payload.streamId]
      if (!run) return
      const message = action.payload.message
      const existing = run.entries.find(entry => entry.message?.id === message.id)
      if (existing) {
        existing.message = message
        existing.persistedEvents = existing.stream?.events ?? run.stream.events
      } else if (message.role === 'assistant' || message.role === 'ex_agent') {
        // ToolLoopService emits first persistence before the next turn_started;
        // post-tool/replay updates reuse the message ID and take the upsert above.
        const live = run.entries.find(entry => entry.key === run.liveKey)
        if (live && !live.message) {
          live.message = message
          live.persistedEvents = live.stream?.events ?? run.stream.events
        } else if (!live) run.entries.push({ key: run.liveKey, message, persistedEvents: run.stream.events })
        else run.entries.push({ key: message.id, message })
      } else {
        run.entries.push({ key: message.id, message })
      }
      if (message.role === 'user' && !run.stream.triggerUserMessageId) run.partial = false
    },
  },
  extraReducers: builder => {
    builder.addCase('users/clearUser', () => initialState)
  },
})

export const agentRunPreviewActions = slice.actions
export default slice.reducer

interface PreviewRoot {
  chat: ChatState
  agentRunPreviews: AgentRunPreviewState
  conversations: { items: Array<{ id: string; project_id?: string | null; title?: string | null }> }
}

const previewTrackedActions = new Set([
  'chat/sendingStarted', 'chat/streamChunkReceived', 'chat/streamLineageUpdated',
  'chat/streamCompleted', 'chat/sendingCompleted', 'chat/streamingAborted',
])

/** Synchronous capture survives component unmounts and batched turn-reset actions. */
export const agentRunPreviewMiddleware: Middleware = api => next => action => {
  const before = api.getState() as PreviewRoot
  const result = next(action)
  const candidate = action as { type?: string; payload?: any }
  if (!candidate.type?.startsWith('chat/')) return result
  if (!previewTrackedActions.has(candidate.type) && candidate.type !== 'chat/allStreamsAborted') return result
  const ids = candidate.type === 'chat/allStreamsAborted'
    ? before.chat.streaming.activeIds : [candidate.payload?.streamId].filter(Boolean)
  const state = api.getState() as PreviewRoot
  for (const streamId of ids) {
    const stream = state.chat.streaming.byId[streamId]
    if (!stream) continue
    const conversation = state.conversations.items.find(item => String(item.id) === String(stream.conversationId))
    api.dispatch(agentRunPreviewActions.synchronized({
      streamId, stream, start: candidate.type === 'chat/sendingStarted',
      boundary: candidate.type === 'chat/streamChunkReceived' &&
        ['generation_started', 'reset'].includes(candidate.payload?.chunk?.type),
      projectId: conversation?.project_id == null ? null : String(conversation.project_id),
      conversationTitle: conversation?.title ?? null,
      now: new Date().toISOString(),
    }))
    // Direct tool/subagent clients use the same complete-chunk vocabulary.
    const completedMessage = candidate.payload?.chunk?.message
    if (completedMessage?.id) {
      api.dispatch(agentRunPreviewActions.messageReceived({ streamId, message: completedMessage }))
    }
  }
  return result
}
