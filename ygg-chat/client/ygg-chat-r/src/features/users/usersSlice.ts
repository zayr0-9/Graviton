// features/users/usersSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { userInitialState } from '../initialStates'
import { User, UserState } from './usersTypes'

const initialState: UserState = userInitialState

// Slice
const usersSlice = createSlice({
  name: 'users',
  initialState,
  reducers: {
    clearUser: state => {
      state.currentUser = null
      state.error = null
    },
    clearError: state => {
      state.error = null
    },
    setUser: (state, action: PayloadAction<User>) => {
      state.currentUser = action.payload
      state.error = null
    },
  }
})

export const { clearUser, clearError, setUser } = usersSlice.actions
export default usersSlice.reducer
