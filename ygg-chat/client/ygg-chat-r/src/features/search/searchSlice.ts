// searchSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { SearchState } from './searchTypes'

const initialState: SearchState = {
  query: '',
  results: [],
  history: [],
  loading: false,
  error: null,
  focusedMessageId: null,
  focusedConversationId: null,
}

export const searchSlice = createSlice({
  name: 'search',
  initialState,
  reducers: {
    queryChanged: (state, action: PayloadAction<string>) => {
      state.query = action.payload
    },
    clearResults: state => {
      state.results = []
      state.error = null
    },
    focusSet: (state, action: PayloadAction<{ conversationId: string; messageId: string } | null>) => {
      state.focusedConversationId = action.payload?.conversationId ?? null
      state.focusedMessageId = action.payload?.messageId ?? null
    },
  }
})

export const searchActions = { ...searchSlice.actions }

export default searchSlice.reducer
