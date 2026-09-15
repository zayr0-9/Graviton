/** Public auth projection. Never put OAuth credentials in this contract. */
export type AuthSlot = 'app' | 'codex'
export type AuthStatus = 'signed_out' | 'ready' | 'refreshing' | 'temporarily_unavailable' | 'reauth_required' | 'configuration_error'
export interface AuthSnapshot {
  slot: AuthSlot
  status: AuthStatus
  sessionId: string | null
  version: number
  userId: string | null
  email: string | null
  expiresAt: number | null
  error?: string
}
