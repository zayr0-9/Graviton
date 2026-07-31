/**
 * AppAuthTokenManager — single owner of the Supabase (Railway) app session,
 * so the renderer and server never race to refresh the same rotating
 * refresh_token.
 *
 * Phase 5: real single-flight refresher. Wraps the electronAppAuth primitives:
 *  - readElectronAppAuthSession()   — read the Conf `auth_session` row.
 *  - shouldRefresh(expiresAt)        — 5-min skew near-expiry check.
 *  - refreshElectronAppAuthSession() — POST /auth/v1/token, writes the rotated
 *                                      session back to the same Conf key.
 *
 * At most one refresh runs process-wide at a time: concurrent callers await the
 * one in-flight promise, then re-read the (now rotated) session. This is the
 * sole in-process refresher the RailwayClient/cloud gateway relies on.
 */

import {
  readElectronAppAuthSession,
  refreshElectronAppAuthSession,
  shouldRefresh,
} from '../providers/electronAppAuth.js'

export interface AppToken {
  userId: string | null
  accessToken: string | null
}

export interface GetFreshAppTokenOptions {
  /**
   * Force a refresh even when the token is not near expiry. Used for 401
   * recovery, where the token is rejected before its own skew window.
   */
  forceRefresh?: boolean
}

export interface AppAuthTokenManager {
  /** Returns a valid app token, refreshing (single-flight) if near expiry. */
  getFreshAppToken(opts?: GetFreshAppTokenOptions): Promise<AppToken>
}

class SingleFlightAppAuthTokenManager implements AppAuthTokenManager {
  /** Non-null while a refresh is in flight; concurrent callers share it. */
  private inflight: Promise<void> | null = null

  async getFreshAppToken(opts?: GetFreshAppTokenOptions): Promise<AppToken> {
    let record = readElectronAppAuthSession()

    const needsRefresh =
      !!record.refreshToken && (opts?.forceRefresh === true || shouldRefresh(record.expiresAt))
    if (needsRefresh && record.refreshToken) {
      await this.refreshOnce(record.refreshToken)
      // Re-read: whoever won the single-flight rotated the Conf session, so
      // queued callers pick up the fresh token rather than starting again.
      record = readElectronAppAuthSession()
    }

    return { userId: record.userId, accessToken: record.accessToken }
  }

  private refreshOnce(refreshToken: string): Promise<void> {
    if (!this.inflight) {
      this.inflight = refreshElectronAppAuthSession(refreshToken)
        .catch(() => null) // a failed refresh must not reject callers; they fall back to the stale read
        .then(() => {
          this.inflight = null
        })
    }
    return this.inflight
  }
}

/** Factory for the process-wide single-flight app-token manager. */
export function createAppAuthTokenManager(): AppAuthTokenManager {
  return new SingleFlightAppAuthTokenManager()
}
