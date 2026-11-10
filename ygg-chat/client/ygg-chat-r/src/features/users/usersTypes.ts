// features/users/usersTypes.ts

/** The single local profile (Graviton has no accounts, credits or subscriptions). */
export interface User {
  id: string
  username: string
  created_at: string
  favorite_conversation_ids?: string[]
}

export interface UserSettings {
  default_theme: 'light' | 'dark' | 'system'
  agent: boolean
}

export interface UserState {
  currentUser: User | null
  loading: boolean
  error: string | null //or could split into error Boolean and errorMessage
}
