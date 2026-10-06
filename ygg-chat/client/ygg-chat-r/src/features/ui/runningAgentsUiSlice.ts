import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export interface AgentsPillSize { width: number; height: number }
const initialState: { expandedSize: AgentsPillSize | null } = { expandedSize: null }

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
    sizeReset: () => initialState,
  },
  extraReducers: builder => { builder.addCase('users/clearUser', () => initialState) },
})

export const runningAgentsUiActions = slice.actions
export default slice.reducer
