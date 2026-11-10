import type Database from 'better-sqlite3'
import type { AuthSlot } from '../../../../shared/auth.js'
import type { HostAuthState } from '../../../../shared/hostRuntime.js'
import { LOCAL_USER_EMAIL, LOCAL_USER_ID } from '../../../../shared/localUser.js'
import { getSettingsStore } from '../headlessServer/config/settingsStore.js'
import { AuthSessionManager, AuthFailure } from './authSessionManager.js'
import { SettingsCredentialStore } from './credentialStore.js'
import { migrateOAuthCredentials, importRendererLegacyCredentials } from './authMigration.js'
import { refreshCredential } from './refreshAdapters.js'
import { ensureLocalUser, reassignLegacyAccountData } from './localIdentity.js'

let manager: AuthSessionManager | undefined
let credentials: SettingsCredentialStore | undefined
export function getAuthManager(): AuthSessionManager {
  if (!manager) {
    credentials = new SettingsCredentialStore(getSettingsStore())
    const record = credentials.read('codex')
    if (record?.refreshPending) credentials.write('codex', { ...record, refreshPending: false, accessToken: '', refreshToken: null, blocked: 'reauth_required' })
    manager = new AuthSessionManager(credentials, refreshCredential)
  }
  return manager
}
export function initializeAuth(db: Database.Database): void {
  const owner = getAuthManager()
  ensureLocalUser(db)
  // Q5: chats a former Graviton sign-in moved to that account return to the local user,
  // then the retired account session is dropped (which also marks this as done).
  const legacyUserId = credentials!.readLegacyAppUserId()
  if (legacyUserId) {
    const moved = reassignLegacyAccountData(db, legacyUserId)
    if (moved > 0) console.log(`[auth] Re-assigned ${moved} local rows from the retired Graviton account to the local user`)
  }
  credentials!.clearLegacyApp()
  const state = migrateOAuthCredentials(getSettingsStore(), credentials!, {
    list: () => db.prepare('SELECT provider, user_id AS userId, access_token AS accessToken, refresh_token AS refreshToken, expires_at AS expiresAt, account_id AS accountId FROM provider_tokens').all() as any[],
    remove: (provider, userId) => { db.prepare('DELETE FROM provider_tokens WHERE provider = ? AND user_id = ?').run(provider, userId) },
  })
  for (const slot of state.needsReconnect) if (!owner.snapshot(slot).sessionId) owner.requireReconnect(slot)
  // D5: ChatGPT refresh scheduling no longer waits for a renderer handoff.
  owner.start()
}
/** Codex-only legacy localStorage handoff (kept for this release; delete next release, Q19). */
export function importLegacyRenderer(values: { codex?: unknown }): void {
  getAuthManager()
  importRendererLegacyCredentials(getSettingsStore(), credentials!, values)
  getAuthManager().start()
}
export function stopAuth(): void { manager?.stop(); manager = undefined; credentials = undefined }

export function acceptCodexSession(tokens: { accessToken: string; refreshToken: string; expiresAt: number; accountId: string; email?: string | null }) {
  if (!tokens.accessToken || !tokens.refreshToken || !tokens.accountId || !Number.isFinite(tokens.expiresAt)) throw new AuthFailure('codex', 'reauth_required', 'Incomplete ChatGPT sign-in response.')
  return getAuthManager().replace('codex', { userId: tokens.accountId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, email: tokens.email })
}
/** Public identity: always the single local user, plus the ChatGPT connection status. */
export function publicAuthState(): HostAuthState {
  return { codex: getAuthManager().snapshot('codex'), user: { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL } }
}
export function disconnectAuth(slot: AuthSlot) {
  getAuthManager().replace(slot, null)
  return publicAuthState()
}
