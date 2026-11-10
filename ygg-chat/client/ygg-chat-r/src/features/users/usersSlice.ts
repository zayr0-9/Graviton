// features/users/usersSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { userInitialState } from '../initialStates'
import { User, UserState } from './usersTypes'
// LocalStorage keys

const initialState: UserState = userInitialState

// Initial state
// const initialState: UserState = {
//   currentUser: loadUserFromStorage(),
//   loading: false,
//   error: null,
// }

// Slice
const usersSlice = createSlice({
  name: 'users',
  initialState,
  reducers: {
    clearUser: state => {
      state.currentUser = null
      state.error = null
      //   removeUserFromStorage()
    },
    clearError: state => {
      state.error = null
    },
    setUser: (state, action: PayloadAction<User>) => {
      state.currentUser = action.payload
      state.error = null
      //   saveUserToStorage(action.payload)
    },
  }
})

export const { clearUser, clearError, setUser } = usersSlice.actions
export default usersSlice.reducer
