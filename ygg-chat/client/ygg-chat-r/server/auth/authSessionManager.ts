import { randomUUID } from 'node:crypto'
import type { AuthSlot, AuthSnapshot, AuthStatus } from '../../../../shared/auth.js'

export interface Credential {
  sessionId: string
  revision: number
  userId: string
  email?: string | null
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  acquiredAt?: number
  refreshPending?: boolean
  rejected?: boolean
  blocked?: 'reauth_required' | 'configuration_error'
}
export interface CredentialStore {
  read(slot: AuthSlot): Credential | null
  write(slot: AuthSlot, value: Credential | null): void
  /** Distinguishes an explicit sign-out from an unmigrated slot. */
  isInitialized(slot: AuthSlot): boolean
}
export class AuthFailure extends Error {
  readonly name = 'AuthFailure'
  constructor(readonly slot: AuthSlot, readonly category: 'reauth_required' | 'temporarily_unavailable' | 'configuration_error', message: string, readonly retryAfterMs?: number) {
    super(message)
  }
  get status(): number { return this.category === 'reauth_required' ? 401 : 503 }
  get errorType(): string { return this.category === 'reauth_required' ? (this.slot === 'app' ? 'reauth_required' : 'provider_signin_required') : 'provider_unavailable' }
}
export type RefreshAdapter = (slot: AuthSlot, credential: Credential, signal: AbortSignal) => Promise<Omit<Credential, 'sessionId' | 'revision'>>

/** One owner per process. Consumers hold session references, not access tokens. */
export class AuthSessionManager {
  private readonly pending = new Map<AuthSlot, Promise<Credential>>()
  private readonly epochs = new Map<AuthSlot, number>()
  private readonly failures = new Map<AuthSlot, AuthFailure>()
  private readonly listeners = new Set<(snapshot: AuthSnapshot) => void>()
  private readonly controllers = new Set<AbortController>()
  private version = 0
  private timer?: ReturnType<typeof setInterval>
  private readonly retryAt = new Map<AuthSlot, number>()
  private readonly attempts = new Map<AuthSlot, number>()
  private readonly rejected = new Set<string>()
  constructor(private readonly store: CredentialStore, private readonly refresh: RefreshAdapter, private readonly now = Date.now, private readonly random = Math.random) {}

  generation(slot: AuthSlot): number { return this.epochs.get(slot) ?? 0 }
  requireReconnect(slot: AuthSlot): void {
    this.epochs.set(slot, (this.epochs.get(slot) ?? 0) + 1)
    this.pending.delete(slot)
    const value = this.store.read(slot)
    if (value) this.store.write(slot, { ...value, accessToken: '', refreshToken: null, blocked: 'reauth_required' })
    this.failures.set(slot, new AuthFailure(slot, 'reauth_required', 'This connection needs you to sign in again.'))
    this.publish(slot)
  }
  snapshot(slot: AuthSlot): AuthSnapshot {
    const value = this.store.read(slot)
    const failure = this.failures.get(slot)
    const status: AuthStatus = failure?.category ?? value?.blocked ?? (this.pending.has(slot) ? 'refreshing' : value ? 'ready' : 'signed_out')
    return { slot, status, sessionId: value?.sessionId ?? null, version: this.version, userId: value?.userId ?? null,
      email: value?.email ?? null, expiresAt: value?.expiresAt ?? null, ...(failure ? { error: failure.message } : {}) }
  }
  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(slot: AuthSlot): void {
    this.version++
    const snapshot = this.snapshot(slot)
    for (const listener of this.listeners) { try { listener(snapshot) } catch { /* A detached UI cannot break credential commit. */ } }
  }
  replace(slot: AuthSlot, value: Omit<Credential, 'sessionId' | 'revision'> | null): AuthSnapshot {
    this.epochs.set(slot, (this.epochs.get(slot) ?? 0) + 1)
    this.pending.delete(slot)
    try {
      this.store.write(slot, value ? { ...value, blocked: undefined, acquiredAt: this.now(), sessionId: randomUUID(), revision: 0 } : null)
    } catch {
      const error = new AuthFailure(slot, 'configuration_error', 'Could not save authentication state. Check storage and reconnect.')
      this.failures.set(slot, error)
      this.publish(slot)
      throw error
    }
    this.failures.delete(slot)
    this.retryAt.delete(slot)
    this.attempts.delete(slot)
    this.publish(slot)
    return this.snapshot(slot)
  }
  async resolve(slot: AuthSlot, options: { sessionId?: string; rejectedRevision?: number; force?: boolean } = {}): Promise<Credential> {
    const value = this.store.read(slot)
    if (!value || (options.sessionId && options.sessionId !== value.sessionId)) throw new AuthFailure(slot, 'reauth_required', 'Sign in again to continue.')
    const requestEpoch = this.epochs.get(slot) ?? 0
    const previousFailure = this.failures.get(slot)
    if (previousFailure?.category === 'reauth_required' || previousFailure?.category === 'configuration_error') throw previousFailure
    if (value.blocked) throw new AuthFailure(slot, value.blocked, 'This connection needs you to sign in again.')
    const rejectedKey = `${slot}:${value.sessionId}:${value.revision}`
    if (options.rejectedRevision === value.revision) {
      this.rejected.add(rejectedKey)
      value.rejected = true
      try { this.store.write(slot, value) } catch { throw new AuthFailure(slot, 'configuration_error', 'Could not save rejected authentication state.') }
    }
    const rejected = value.rejected === true || this.rejected.has(rejectedKey)
    const lifetime = value.expiresAt !== null && value.acquiredAt !== undefined ? value.expiresAt - value.acquiredAt : 3_600_000
    const skew = Math.min(300_000, Math.max(1_000, lifetime * 0.1))
    if (!rejected && !options.force && value.expiresAt !== null && value.expiresAt - this.now() > skew) return value
    if (previousFailure && (this.retryAt.get(slot) ?? 0) > this.now()) {
      if (!rejected && !options.force && value.expiresAt !== null && value.expiresAt > this.now()) return value
      throw previousFailure
    }
    let work = this.pending.get(slot)
    if (!work) {
      const epoch = this.epochs.get(slot) ?? 0
      const controller = new AbortController()
      this.controllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), 20_000)
      work = Promise.resolve().then(async () => {
        if (!value.refreshToken) throw new AuthFailure(slot, 'reauth_required', 'Sign in again to renew this session.')
        // Crash marker prevents reusing a possibly rotated refresh token after restart.
        try { this.store.write(slot, { ...value, refreshPending: true }) }
        catch { throw new AuthFailure(slot, 'configuration_error', 'Could not prepare credential renewal. Check storage.') }
        // Enforce the owner timeout even if an adapter ignores cancellation.
        let onAbort!: () => void
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new AuthFailure(slot, 'temporarily_unavailable', 'Authentication renewal timed out. It will retry automatically.'))
          if (controller.signal.aborted) onAbort()
          else controller.signal.addEventListener('abort', onAbort, { once: true })
        })
        const rotated = await Promise.race([this.refresh(slot, value, controller.signal), aborted])
          .finally(() => controller.signal.removeEventListener('abort', onAbort))
        controller.signal.throwIfAborted()
        if ((this.epochs.get(slot) ?? 0) !== epoch) throw new AuthFailure(slot, 'reauth_required', 'The active account changed. Start a new request.')
        if (rotated.userId !== value.userId) throw new AuthFailure(slot, 'reauth_required', 'The refreshed account does not match this session.')
        if (!rotated.accessToken || rotated.expiresAt === null || !Number.isFinite(rotated.expiresAt) || rotated.expiresAt <= this.now()) throw new AuthFailure(slot, 'temporarily_unavailable', 'Authentication service returned an expired or incomplete session.')
        const next = { ...rotated, rejected: false, refreshPending: false, blocked: undefined, acquiredAt: this.now(), sessionId: value.sessionId, revision: value.revision + 1 }
        try { this.store.write(slot, next) } catch { throw new AuthFailure(slot, 'configuration_error', 'Could not save renewed credentials. Check storage and reconnect.') }
        this.failures.delete(slot)
        this.retryAt.delete(slot)
        this.attempts.delete(slot)
        this.rejected.delete(rejectedKey)
        return next
      }).catch(error => {
        const failure = error instanceof AuthFailure ? error : new AuthFailure(slot, 'temporarily_unavailable', 'Could not renew the connection. It will retry automatically.')
        if ((this.epochs.get(slot) ?? 0) === epoch) {
          this.failures.set(slot, failure)
          if (failure.category === 'temporarily_unavailable') {
            try { this.store.write(slot, { ...value, refreshPending: false }) }
            catch { this.failures.set(slot, new AuthFailure(slot, 'configuration_error', 'Could not save authentication recovery state.')) }
          }
          if (failure.category === 'reauth_required') {
            // Retain identity, but never retry revoked rotating secrets after restart.
            try { this.store.write(slot, { ...value, accessToken: '', refreshToken: null, blocked: 'reauth_required' }) }
            catch { this.failures.set(slot, new AuthFailure(slot, 'configuration_error', 'Could not save disconnected authentication state.')) }
          }
          const attempts = (this.attempts.get(slot) ?? 0) + 1
          this.attempts.set(slot, attempts)
          this.retryAt.set(slot, this.now() + Math.max(failure.retryAfterMs ?? 0, Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)) * (0.8 + this.random() * 0.4)))
        }
        throw failure
      }).finally(() => {
        clearTimeout(timeout)
        this.controllers.delete(controller)
        if (this.pending.get(slot) === work) this.pending.delete(slot)
        this.publish(slot)
      })
      this.pending.set(slot, work)
      this.publish(slot)
    }
    try {
      const result = await work
      if ((this.epochs.get(slot) ?? 0) !== requestEpoch || this.store.read(slot)?.sessionId !== result.sessionId) throw new AuthFailure(slot, 'reauth_required', 'The active account changed. Start a new request.')
      return result
    } catch (error) {
      if (error instanceof AuthFailure && error.category === 'temporarily_unavailable' && !rejected && !this.rejected.has(rejectedKey) && !options.force && (this.epochs.get(slot) ?? 0) === requestEpoch && this.store.read(slot)?.sessionId === value.sessionId && value.expiresAt !== null && value.expiresAt > this.now()) return value
      throw error
    }
  }
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.check() }, 30_000)
    this.timer.unref?.()
    void this.check()
  }
  async check(): Promise<void> {
    await Promise.all((['app', 'codex'] as const).map(async slot => {
      if (this.store.read(slot)) await this.resolve(slot).catch(() => undefined)
    }))
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const slot of ['app', 'codex'] as const) this.epochs.set(slot, (this.epochs.get(slot) ?? 0) + 1)
    for (const controller of this.controllers) controller.abort()
  }
}
