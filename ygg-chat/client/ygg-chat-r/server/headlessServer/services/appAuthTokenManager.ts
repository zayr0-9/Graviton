import { getAuthManager } from '../../auth/runtime.js'

export interface AppToken { userId: string | null; accessToken: string | null; revision?: number; sessionId?: string }
export interface GetFreshAppTokenOptions { forceRefresh?: boolean; rejectedRevision?: number; sessionId?: string }
export interface AppAuthTokenManager { getFreshAppToken(opts?: GetFreshAppTokenOptions): Promise<AppToken> }

/** Railway adapter only. Credential ownership/refresh lives in server/auth. */
export function createAppAuthTokenManager(): AppAuthTokenManager {
  return {
    async getFreshAppToken(opts) {
      const owner = getAuthManager()
      if (!owner.snapshot('app').sessionId && !opts?.sessionId) return { userId: null, accessToken: null }
      const value = await owner.resolve('app', { sessionId: opts?.sessionId, rejectedRevision: opts?.rejectedRevision, force: opts?.forceRefresh && opts?.rejectedRevision === undefined })
      return { userId: value.userId, accessToken: value.accessToken, sessionId: value.sessionId, revision: value.revision }
    },
  }
}
