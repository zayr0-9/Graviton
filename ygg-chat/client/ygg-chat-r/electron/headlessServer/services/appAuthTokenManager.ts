/**
 * AppAuthTokenManager — single owner of the Supabase (Railway) app session,
 * so the renderer and server never race to refresh the same rotating
 * refresh_token.
 *
 * Phase 0 SKELETON. Not wired yet; the real single-flight refresh + Conf
 * writes land in Phase 4 (cloud gateway). Kept inert (no imports of the
 * electronAppAuth primitives yet) so it cannot affect current behavior.
 *
 * Intended Phase 4 behavior:
 * - Wrap electronAppAuth.read/refresh with an in-flight promise mutex so there
 *   is exactly one refresher process-wide.
 * - Be the sole writer of the Conf `auth_session` key.
 * - Expose getFreshAppToken() to the railway client and provider adapters.
 */

export interface AppToken {
  userId: string | null
  accessToken: string | null
}

export interface AppAuthTokenManager {
  /** Returns a valid app token, refreshing (single-flight) if near expiry. */
  getFreshAppToken(): Promise<AppToken>
}

class NotImplementedAppAuthTokenManager implements AppAuthTokenManager {
  async getFreshAppToken(): Promise<AppToken> {
    throw new Error('AppAuthTokenManager.getFreshAppToken is not implemented until Phase 4 (cloud gateway).')
  }
}

/** Placeholder factory. Replaced with the real single-flight manager in Phase 4. */
export function createAppAuthTokenManager(): AppAuthTokenManager {
  return new NotImplementedAppAuthTokenManager()
}
