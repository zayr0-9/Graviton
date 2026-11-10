import type { QueryClient } from '@tanstack/react-query'

// Store extra argument type for thunks - provides the local identity and queryClient to all Redux actions
export interface ThunkExtraArgument {
  auth: {
    userId: string | null
  }
  queryClient: QueryClient | null
}

export let thunkExtraArg: ThunkExtraArgument = {
  auth: {
    userId: null,
  },
  queryClient: null,
}

export const updateThunkExtraAuth = (userId: string | null) => {
  thunkExtraArg.auth.userId = userId
}

// Function to update the thunk extra argument with queryClient instance
export const updateThunkExtraQueryClient = (queryClient: QueryClient) => {
  thunkExtraArg.queryClient = queryClient
}
