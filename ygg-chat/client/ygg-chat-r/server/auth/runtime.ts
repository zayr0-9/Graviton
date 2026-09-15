import type Database from 'better-sqlite3'
import type { AuthSlot } from '../../../../shared/auth.js'
import { getSettingsStore } from '../headlessServer/config/settingsStore.js'
import { AuthSessionManager, AuthFailure } from './authSessionManager.js'
import { SettingsCredentialStore } from './credentialStore.js'
import { migrateOAuthCredentials, importRendererLegacyCredentials } from './authMigration.js'
import { refreshCredential, expiryMs, jwtMetadata, supabaseConfig } from './refreshAdapters.js'

let manager: AuthSessionManager | undefined
let credentials: SettingsCredentialStore | undefined
export function getAuthManager(): AuthSessionManager {
  if (!manager) {
    credentials = new SettingsCredentialStore(getSettingsStore())
    for (const slot of ['app', 'codex'] as const) {
      const record = credentials.read(slot)
      if (record?.refreshPending) credentials.write(slot, { ...record, refreshPending: false, accessToken: '', refreshToken: null, blocked: 'reauth_required' })
    }
    manager = new AuthSessionManager(credentials, refreshCredential)
  }
  return manager
}
export function initializeAuth(db: Database.Database): void {
  const owner = getAuthManager()
  const legacy = getSettingsStore().get('auth_session') as any
  if (legacy?.accessToken === 'electron-local-token' || legacy?.session?.access_token === 'electron-local-token') getSettingsStore().set('local_login_enabled', true)
  const state = migrateOAuthCredentials(getSettingsStore(), credentials!, {
    list: () => db.prepare('SELECT provider, user_id AS userId, access_token AS accessToken, refresh_token AS refreshToken, expires_at AS expiresAt, account_id AS accountId FROM provider_tokens').all() as any[],
    remove: (provider, userId) => { db.prepare('DELETE FROM provider_tokens WHERE provider = ? AND user_id = ?').run(provider, userId) },
  })
  for (const slot of state.needsReconnect) if (!owner.snapshot(slot).sessionId) owner.requireReconnect(slot)
  if (state.rendererCleaned) owner.start()
}
export function importLegacyRenderer(values: { app?: unknown; codex?: unknown }): void {
  getAuthManager()
  importRendererLegacyCredentials(getSettingsStore(), credentials!, values)
  getAuthManager().start()
}
export function stopAuth(): void { manager?.stop(); manager = undefined; credentials = undefined }

/** Called only by validated server-side login flows, never by ordinary requests. */
export async function acceptAppSession(accessToken: string, refreshToken: string, isCurrent = () => true) {
  const owner = getAuthManager()
  const generation = owner.generation('app')
  const { url, key } = supabaseConfig()
  const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new AuthFailure('app', 'reauth_required', 'Could not validate this sign-in. Please try again.')
  const user = await response.json() as any
  if (typeof user?.id !== 'string' || !user.id || !refreshToken) throw new AuthFailure('app', 'reauth_required', 'Incomplete sign-in response.')
  if (!isCurrent() || owner.generation('app') !== generation) throw new AuthFailure('app', 'reauth_required', 'Sign-in was cancelled.')
  owner.replace('app', { userId: user.id, email: user.email, accessToken, refreshToken, expiresAt: expiryMs(jwtMetadata(accessToken).exp) })
  return { user, snapshot: owner.snapshot('app') }
}
export function acceptCodexSession(tokens: { accessToken: string; refreshToken: string; expiresAt: number; accountId: string; email?: string | null }) {
  if (!tokens.accessToken || !tokens.refreshToken || !tokens.accountId || !Number.isFinite(tokens.expiresAt)) throw new AuthFailure('codex', 'reauth_required', 'Incomplete ChatGPT sign-in response.')
  return getAuthManager().replace('codex', { userId: tokens.accountId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, email: tokens.email })
}
export function publicAuthState() {
  const app = getAuthManager().snapshot('app')
  const local = !app.userId && getSettingsStore().get('local_login_enabled') === true
  return { app, codex: getAuthManager().snapshot('codex'), user: app.userId ? { id: app.userId, email: app.email } : local ? { id: 'a7c485cb-99e7-4cf2-82a9-6e23b55cdfc3', email: 'electron@localhost' } : null }
}
export function enableLocalLogin() {
  getSettingsStore().set('local_login_enabled', true)
  getAuthManager().replace('app', null)
  return publicAuthState()
}
export function disconnectAuth(slot: AuthSlot) {
  if (slot === 'app') getSettingsStore().set('local_login_enabled', false)
  getAuthManager().replace(slot, null)
  return publicAuthState()
}
