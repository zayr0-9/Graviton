// features/users/usersTypes.ts

export interface User {
  id: string
  username: string
  created_at: string
  max_credits: number
  cached_current_credits: number
  total_spent: number
  credits_enabled: boolean
  last_reset_at?: string | null
  reset_period: 'none' | 'daily' | 'monthly' | 'yearly'
  stripe_customer_id?: string | null
  active_subscription_id?: string | null
  free_generations_remaining: number
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

export interface LoginUserPayload {
  username: string
}
