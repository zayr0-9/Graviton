// Host identity types. Identity is always the single local user; the provider only
// projects it and the ChatGPT (Codex) connection status.

export interface User {
  id: string
  email?: string | null
  username?: string
  [key: string]: any
}

export interface AuthState {
  user: User | null
  userId: string | null
  loading: boolean
}

export type AuthChangeCallback = (user: User | null) => void

export interface AuthProvider {
  /** Called once at app startup. */
  initialize(): Promise<void>
  dispose?(): void
  /** Current identity from the last host projection (no network calls). */
  getSession(): Promise<AuthState>
  /** Re-checks the ChatGPT connection on the host and re-reads the identity. */
  refreshToken(): Promise<AuthState>
  /** Subscribe to identity/status changes. Returns an unsubscribe function. */
  onAuthStateChange(callback: AuthChangeCallback): () => void
}
