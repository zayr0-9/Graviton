import type { AuthSlot } from '../../../../shared/auth.js'
import type { Credential, CredentialStore } from './authSessionManager.js'
import type { KeyValueStore } from '../hostCapabilities.js'

export const AUTH_STORE_KEY = 'managed_auth_v1'
interface PersistedAuth { version: 1; app: Credential | null; codex: Credential | null; initialized: Partial<Record<AuthSlot, boolean>> }
/** Whole-record writes use the injected settings persistence (Conf in Electron).
 * Read-back detects failed writes; it is not an fsync guarantee for other hosts.
 */
export class SettingsCredentialStore implements CredentialStore {
  constructor(private readonly settings: KeyValueStore) {}
  read(slot: AuthSlot): Credential | null {
    const persisted = this.settings.get(AUTH_STORE_KEY) as PersistedAuth | undefined
    if (!persisted) return null
    if (persisted.version !== 1) throw new Error('Unsupported authentication store schema')
    const value = persisted[slot]
    if (value == null) return null
    if (typeof value.sessionId !== 'string' || !value.sessionId || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        typeof value.userId !== 'string' || !value.userId || typeof value.accessToken !== 'string' ||
        (value.refreshToken !== null && typeof value.refreshToken !== 'string') ||
        (value.expiresAt !== null && !Number.isFinite(value.expiresAt)) ||
        (value.blocked !== undefined && value.blocked !== 'reauth_required' && value.blocked !== 'configuration_error')) {
      throw new Error('Invalid authentication store record')
    }
    return { ...value }
  }
  isInitialized(slot: AuthSlot): boolean {
    return (this.settings.get(AUTH_STORE_KEY) as PersistedAuth | undefined)?.initialized?.[slot] === true
  }
  write(slot: AuthSlot, value: Credential | null): void {
    const current = this.settings.get(AUTH_STORE_KEY) as PersistedAuth | undefined
    const next: PersistedAuth = { version: 1, app: current?.app ?? null, codex: current?.codex ?? null, [slot]: value, initialized: { ...current?.initialized, [slot]: true } }
    this.settings.set(AUTH_STORE_KEY, next)
    if (JSON.stringify(this.settings.get(AUTH_STORE_KEY)) !== JSON.stringify(next)) throw new Error('Credential persistence failed')
  }
}
