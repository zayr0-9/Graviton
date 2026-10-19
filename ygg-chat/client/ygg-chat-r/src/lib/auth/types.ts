// Auth provider types and interfaces

export interface User {
  id: string
  email?: string
  username?: string
  [key: string]: any
}

export interface Session {
  access_token: string
  refresh_token?: string
  expires_at?: number
  user?: User
  [key: string]: any
}

export interface AuthState {
  user: User | null
  session: Session | null
  loading: boolean
  accessToken: string | null
  userId: string | null
}

export interface Credentials {
  email: string
  password: string
}

export type AuthChangeCallback = (user: User | null) => void

/**
 * Auth Provider Interface
 *
 * All authentication implementations must conform to this interface.
 * This allows us to swap between Supabase, Electron, and local auth seamlessly.
 */
export interface AuthProvider {
  /**
   * Initialize the auth provider
   * Should be called once at app startup
   */
  initialize(): Promise<void>
  dispose?(): void

  /**
   * Get the current session from storage (no network calls)
   */
  getSession(): Promise<AuthState>

  /**
   * Login with credentials
   */
  login(credentials: Credentials): Promise<AuthState>

  /**
   * Logout current user
   */
  logout(): Promise<void>

  /**
   * Refresh the access token if needed
   */
  refreshToken(): Promise<AuthState>

  /**
   * Subscribe to auth state changes
   * Returns an unsubscribe function
   */
  onAuthStateChange(callback: AuthChangeCallback): () => void

  /**
   * Check if the provider requires network auth
   * (e.g., Supabase does, local/electron don't)
   */
  requiresNetworkAuth(): boolean
}
