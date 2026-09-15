import { randomUUID } from 'node:crypto'
import type { AuthSlot } from '../../../../shared/auth.js'
import type { KeyValueStore } from '../hostCapabilities.js'
import type { Credential, CredentialStore } from './authSessionManager.js'
import { expiryMs, jwtMetadata } from './refreshAdapters.js'

export const AUTH_MIGRATION_KEY = 'managed_auth_migration_v1'
export interface LegacyOAuthRow {
  provider: string
  userId: string
  accessToken: string
  refreshToken?: string | null
  accountId?: string | null
  expiresAt?: string | null
}
export interface LegacyOAuthRows {
  list(): LegacyOAuthRow[]
  remove(provider: string, userId: string): void
}
interface MigrationState { complete: boolean; rendererCleaned: boolean; needsReconnect: AuthSlot[] }

function candidate(slot: AuthSlot, raw: any): Credential | null {
  const accessToken = slot === 'app' ? raw?.session?.access_token ?? raw?.accessToken : raw?.accessToken
  if (typeof accessToken !== 'string' || !accessToken || accessToken === 'electron-local-token' || accessToken === 'local-mode-token') return null
  const metadata = jwtMetadata(accessToken)
  const claimedId = slot === 'app' ? metadata.sub : metadata['https://api.openai.com/auth']?.chatgpt_account_id
  const suppliedId = slot === 'app' ? raw?.session?.user?.id ?? raw?.user?.id ?? raw?.userId : raw?.accountId
  // JWT claims are hints for grouping legacy records, not proof of authentication.
  if (claimedId && suppliedId && claimedId !== suppliedId) return null
  const userId = claimedId || suppliedId
  const refreshToken = slot === 'app' ? raw?.session?.refresh_token ?? raw?.refreshToken : raw?.refreshToken
  if (typeof userId !== 'string' || !userId || typeof refreshToken !== 'string' || !refreshToken) return null
  return { sessionId: randomUUID(), revision: 0, userId, accessToken, refreshToken,
    email: raw?.email ?? raw?.user?.email ?? raw?.session?.user?.email ?? null,
    expiresAt: expiryMs(slot === 'app' ? raw?.session?.expires_at ?? raw?.expiresAt : raw?.expiresAt) ?? expiryMs(metadata.exp) }
}

/**
 * Conservative one-way import: identical aliases are deduplicated; divergent
 * rotating credentials require reconnect rather than guessing which is valid.
 * Canonical commits always precede legacy deletion. Safe to repeat after a crash.
 */
export function migrateOAuthCredentials(settings: KeyValueStore, store: CredentialStore, rows: LegacyOAuthRows): MigrationState {
  const previous = settings.get(AUTH_MIGRATION_KEY) as MigrationState | undefined
  const legacyRows = rows.list().filter(row => row.provider === 'openrouter' || row.provider === 'openaichatgpt')
  const needsReconnect: AuthSlot[] = [...(previous?.needsReconnect ?? [])]
  if (!previous?.complete) {
    for (const slot of ['app', 'codex'] as const) {
      if (store.isInitialized(slot)) continue
      const raw = settings.get(slot === 'app' ? 'auth_session' : 'openai_chatgpt_tokens')
      const primary = candidate(slot, raw)
      const records = [primary, ...legacyRows.filter(row => row.provider === (slot === 'app' ? 'openrouter' : 'openaichatgpt')).map(row => candidate(slot, row))]
        .filter((value): value is Credential => value !== null)
      const active = primary ? records.filter(value => value.userId === primary.userId) : records
      const distinct = new Map(active.map(value => [JSON.stringify([value.userId, value.accessToken, value.refreshToken]), value]))
      if (distinct.size === 1) store.write(slot, [...distinct.values()][0])
      else if (distinct.size > 1 && !needsReconnect.includes(slot)) needsReconnect.push(slot)
    }
    // Marker prevents obsolete renderer data resurrecting a disconnected session.
    settings.set(AUTH_MIGRATION_KEY, { complete: true, rendererCleaned: false, needsReconnect })
    if (!(settings.get(AUTH_MIGRATION_KEY) as MigrationState | undefined)?.complete) throw new Error('Auth migration marker could not be persisted')
  }
  // Do not clear renderer-only migration candidates here: handoff is separate.
  settings.delete?.('auth_session')
  settings.delete?.('openai_chatgpt_tokens')
  for (const row of legacyRows) rows.remove(row.provider, row.userId)
  return settings.get(AUTH_MIGRATION_KEY) as MigrationState
}

/** One-time startup handoff. Must be exposed only to the trusted desktop renderer. */
export function importRendererLegacyCredentials(settings: KeyValueStore, store: CredentialStore, values: { app?: unknown; codex?: unknown }): void {
  const state = settings.get(AUTH_MIGRATION_KEY) as MigrationState | undefined
  if (!state?.complete) throw new Error('Main-process auth migration must complete first')
  if (state.rendererCleaned) return
  for (const slot of ['app', 'codex'] as const) {
    if (state.needsReconnect.includes(slot)) continue
    const value = candidate(slot, values[slot])
    const canonical = store.read(slot)
    if (canonical && value && canonical.revision === 0 && canonical.acquiredAt === undefined &&
        (canonical.userId !== value.userId || canonical.refreshToken !== value.refreshToken)) {
      store.write(slot, { ...canonical, accessToken: '', refreshToken: null, blocked: 'reauth_required' })
      state.needsReconnect.push(slot)
    } else if (!store.isInitialized(slot) && value) store.write(slot, value)
  }
  settings.set(AUTH_MIGRATION_KEY, { ...state, rendererCleaned: true })
  if (!(settings.get(AUTH_MIGRATION_KEY) as MigrationState)?.rendererCleaned) throw new Error('Renderer auth migration could not be persisted')
}
