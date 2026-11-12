import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export interface AgentsPillSize { width: number; height: number }

/** Bounded session list; stale keys for released forks are harmless but should not grow forever. */
export const MAX_HIDDEN_AGENT_FORKS = 200

interface RunningAgentsUiState {
  expandedSize: AgentsPillSize | null
  /** Grid cards hidden by the user: fork key → stream IDs known when hidden. A new run resurfaces the fork. */
  hiddenForks: Record<string, string[]>
  /** Grid cards narrowed to a strip so row neighbours take the width. Oldest first. */
  collapsedForks: string[]
}

const initialState: RunningAgentsUiState = { expandedSize: null, hiddenForks: {}, collapsedForks: [] }

const slice = createSlice({
  name: 'runningAgentsUi',
  initialState,
  reducers: {
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
