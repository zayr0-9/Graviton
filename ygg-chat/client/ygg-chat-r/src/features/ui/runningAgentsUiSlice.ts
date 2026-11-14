import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { emptyFollowUpDraft, followUpCapacity, type AgentFollowUpDraft, type AgentFollowUpAttempt } from './agentFollowUpState'

export interface AgentsPillSize { width: number; height: number }

/** Bounded session list; stale keys for released forks are harmless but should not grow forever. */
export const MAX_HIDDEN_AGENT_FORKS = 200

interface RunningAgentsUiState {
  followUps: Record<string, AgentFollowUpDraft>
  expandedSize: AgentsPillSize | null
  /** Grid cards hidden by the user: fork key → stream IDs known when hidden. A new run resurfaces the fork. */
  hiddenForks: Record<string, string[]>
  /** Grid cards narrowed to a strip so row neighbours take the width. Oldest first. */
  collapsedForks: string[]
}

const initialState: RunningAgentsUiState = { followUps: {}, expandedSize: null, hiddenForks: {}, collapsedForks: [] }

const slice = createSlice({
  name: 'runningAgentsUi',
  initialState,
  reducers: {
    followUpChanged: (state, action: PayloadAction<{ key: string; content: string; streamIds: string[] }>) => {
      const { key, content, streamIds } = action.payload
      // Only empty, settled records can be reclaimed. Never discard unsent text.
      for (const [id, draft] of Object.entries(state.followUps)) {
        if (id !== key && !draft.content && !draft.attempt && ['idle', 'accepted', 'rejected'].includes(draft.status)) delete state.followUps[id]
      }
      if (!followUpCapacity(state.followUps, key, content)) return
      const draft = state.followUps[key] ??= emptyFollowUpDraft()
      draft.content = content
      draft.revision++
      if (draft.status === 'accepted') draft.status = 'idle'
      if (draft.status === 'rejected') {
        draft.policy = undefined
        draft.attempt = undefined
        draft.error = undefined
        draft.status = 'idle'
      }
      draft.streamIds = [...new Set([...draft.streamIds, ...streamIds])]
    },
    followUpLinked: (state, action: PayloadAction<{ key: string; forkKey: string; streamIds: string[] }>) => {
      const draft = state.followUps[action.payload.key]
      if (draft) draft.streamIds = [...new Set([...draft.streamIds, action.payload.forkKey, ...action.payload.streamIds])].slice(-256)
    },
    followUpPreparing: (state, action: PayloadAction<string>) => {
      const draft = state.followUps[action.payload]
      if (draft && !['preparing', 'sending'].includes(draft.status)) { draft.status = 'preparing'; draft.error = undefined }
    },
    followUpStarted: (state, action: PayloadAction<{ key: string; attempt: AgentFollowUpAttempt }>) => {
      const draft = state.followUps[action.payload.key]
      if (!draft) return
      draft.attempt = action.payload.attempt
      draft.status = 'sending'
      draft.error = undefined
      draft.policy = undefined
    },
    followUpSettled: (state, action: PayloadAction<{ key: string; requestId?: string; streamId?: string; error?: string; uncertain?: boolean; policy?: boolean }>) => {
      const draft = state.followUps[action.payload.key]
      if (!draft || (action.payload.requestId && draft.attempt?.requestId !== action.payload.requestId)) return
      const { streamId, error, uncertain, policy } = action.payload
      if (streamId) {
        if (draft.revision === draft.attempt?.revision) { draft.content = ''; draft.revision++ }
        draft.acceptedStreamId = streamId
        draft.streamIds = [...new Set([...draft.streamIds, streamId])]
        draft.status = 'accepted'
        draft.attempt = undefined
      } else {
        draft.status = uncertain ? 'unknown' : 'rejected'
        draft.error = error
        draft.policy = policy
        // Preserve submitted text independently of edits made while awaiting acknowledgement.
        // Unknown delivery additionally retains its immutable request identity for reconciliation.
      }
    },
    sizeChanged: (state, action: PayloadAction<AgentsPillSize>) => {
      const { width, height } = action.payload
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        state.expandedSize = { width, height }
      }
    },
    sizeReset: state => { state.expandedSize = null },
    forkHidden: (state, action: PayloadAction<{ key: string; streamIds: string[] }>) => {
      const { key, streamIds } = action.payload
      delete state.hiddenForks[key]
      state.hiddenForks[key] = [...new Set(streamIds)]
      const keys = Object.keys(state.hiddenForks)
      for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_HIDDEN_AGENT_FORKS))) delete state.hiddenForks[stale]
    },
    forkShown: (state, action: PayloadAction<string>) => { delete state.hiddenForks[action.payload] },
    allForksShown: state => { state.hiddenForks = {} },
    forkCollapsed: (state, action: PayloadAction<string>) => {
      state.collapsedForks = [...state.collapsedForks.filter(key => key !== action.payload), action.payload]
        .slice(-MAX_HIDDEN_AGENT_FORKS)
    },
    forkExpanded: (state, action: PayloadAction<string>) => {
      state.collapsedForks = state.collapsedForks.filter(key => key !== action.payload)
    },
  },
  extraReducers: builder => { builder.addCase('users/clearUser', () => initialState) },
})

/** Hidden until the fork gains a run the user had not seen when hiding it. */
export function isAgentForkHidden(hiddenForks: Record<string, string[]>, key: string, streamIds: readonly string[]): boolean {
  const known = hiddenForks[key]
  return Boolean(known) && streamIds.every(id => known.includes(id))
}

export const runningAgentsUiActions = slice.actions
export default slice.reducer
