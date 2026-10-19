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
  bootstrapInstalling?: boolean
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

/** Track the newest start for navigation without evicting older fork transcripts. */
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
        // Unknown terminal events must not create a transcript without a captured start.
        if (!start) return
        run = state.byStreamId[streamId] = {
          streamId, stream, projectId, conversationTitle, completedAt: null,
          entries: [], turn: 0, liveKey: `${streamId}:turn:0`, partial: true,
        }
      }
      if (run.bootstrapInstalling) {
        if (stream.active) return
        run.bootstrapInstalling = false
      }
      const identityChanged = previewForkKey(streamId, run.stream) !== previewForkKey(streamId, stream)
      const ended = run.stream.active && !stream.active
      if (boundary && run.entries.some(entry => entry.key === run.liveKey)) {
        run.turn += 1
        run.liveKey = `${streamId}:turn:${run.turn}`
      }
      run.stream = { ...stream, createdAt: run.stream.createdAt }
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
    bootstrapReceived: (state, action: PayloadAction<{ streamId: string; messages: Message[]; parentId?: string | null }>) => {
      const run = state.byStreamId[action.payload.streamId]
      if (!run) return
      run.bootstrapInstalling = true
      // Snapshot rows are the run's durable journal; compact events carry only the
      // previous anchor/current turn. The starting parent belongs to an earlier run.
      const messages = action.payload.messages.filter(message => message.id !== action.payload.parentId)
      const byId = new Map(messages.map(message => [message.id, message]))
      const ordered: Message[] = []
      const visited = new Set<string>()
      for (const message of messages) {
        const chain: Message[] = []
        let current: Message | undefined = message
        while (current && !visited.has(current.id)) {
          visited.add(current.id)
          chain.push(current)
          current = current.parent_id ? byId.get(current.parent_id) : undefined
        }
        ordered.push(...chain.reverse())
      }
      const previous = new Map(run.entries.filter(entry => entry.message).map(entry => [entry.message!.id, entry]))
      run.entries = ordered.map(message => ({ key: previous.get(message.id)?.key ?? message.id, message }))
      // Never replay new snapshot output into the old live entry.
      run.turn += 1
      run.liveKey = `${run.streamId}:turn:${run.turn}`
      if (messages.some(message => message.role === 'user')) run.partial = false
    },
    bootstrapFinished: (state, action: PayloadAction<{ streamId: string; stream: StreamState }>) => {
      const run = state.byStreamId[action.payload.streamId]
      if (!run) return
      run.bootstrapInstalling = false
      run.stream = { ...action.payload.stream, createdAt: run.stream.createdAt }
      const stream = run.stream
      if (!stream.active) run.completedAt ??= new Date().toISOString()
      if (hasOutput(stream)) {
        const persisted = run.entries.find(entry => entry.message?.id === stream.persistedTurnMessageId)
        if (persisted) {
          persisted.stream = stream
          persisted.persistedEvents = stream.events
          run.liveKey = persisted.key
        } else run.entries.push({ key: run.liveKey, stream })
      }
      reconcileRetention(state)
    },
    messageReceived: (state, action: PayloadAction<{ streamId: string; message: Message }>) => {
      const run = state.byStreamId[action.payload.streamId]
      if (!run || run.bootstrapInstalling) return
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
  'chat/streamBootstrapReconciled', 'chat/streamCompleted', 'chat/sendingCompleted', 'chat/streamingAborted', 'chat/streamCompactionUpdated',
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
    if (candidate.type === 'chat/streamBootstrapReconciled') {
      api.dispatch(agentRunPreviewActions.bootstrapFinished({ streamId, stream }))
      continue
    }
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
