import { store } from '../../store/store'
import { isBrowserClient } from '../../platform/clientCapabilities'
import { hostAuthTransport } from './transport'
import { uiActions } from '../../features/ui'
import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors'
import { getPublicAuth, setPublicAuth, type PublicAuthState } from './publicState'
import type { AuthProvider, AuthState, Credentials, AuthChangeCallback } from './types'
export class ManagedAuthProvider implements AuthProvider {
  private listeners = new Set<AuthChangeCallback>()
  private cleanup: (() => void) | undefined
  private readonly retiredEpochs = new Set<string>()
  dispose() { this.cleanup?.(); this.cleanup = undefined; this.listeners.clear() }
  private adopt = (value: PublicAuthState) => {
    const current = getPublicAuth()
    if (value.epoch && this.retiredEpochs.has(value.epoch)) return
    if (current?.epoch && value.epoch && current.epoch !== value.epoch) this.retiredEpochs.add(current.epoch)
    if (current && current.epoch === value.epoch &&
      (value.app.version < current.app.version || value.codex.version < current.codex.version)) return
    const previous = current
    setPublicAuth(value)
    for (const slot of ['app', 'codex'] as const) {
      const snapshot = value[slot]
      if (previous?.[slot].status === snapshot.status && previous?.[slot].sessionId === snapshot.sessionId) continue
      const id = `auth:${slot}`
      if (snapshot.status === 'reauth_required') store.dispatch(uiActions.errorNoticeRaised({ id, source: 'unknown', envelope: buildChatErrorEnvelope(slot === 'app' ? 'session_expired' : 'provider_signin_required', { provider: slot === 'app' ? 'openrouter' : 'openaichatgpt' }) }))
      else if (snapshot.status === 'configuration_error' || snapshot.status === 'temporarily_unavailable') store.dispatch(uiActions.errorNoticeRaised({ id, source: 'unknown', envelope: buildChatErrorEnvelope('provider_unavailable', { userMessage: snapshot.error || 'Authentication is temporarily unavailable.' }) }))
      else if (snapshot.status === 'ready' || snapshot.status === 'signed_out') store.dispatch(uiActions.errorNoticeDismissed(id))
    }
    window.dispatchEvent(new CustomEvent('managed-auth-changed', { detail: value }))
    for (const listener of this.listeners) listener(value.user as any)
  }
  async initialize() {
    const api = hostAuthTransport()
    if (!isBrowserClient) {
      const read = (key: string) => { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
      const raw = read('supabase-auth-token')
      await window.electronAPI!.auth.migrate({ app: raw ? { session: raw.currentSession || raw.session || raw } : null, codex: read('openai_chatgpt_tokens') })
      localStorage.removeItem('supabase-auth-token')
      localStorage.removeItem('openai_chatgpt_tokens')
    }
    const unsubscribe = api.onChanged(this.adopt)
    const onOnline = () => { void api.check().then(this.adopt).catch(() => undefined) }
    window.addEventListener('online', onOnline)
    this.cleanup = () => { unsubscribe?.(); window.removeEventListener('online', onOnline) }
    try { this.adopt(await api.status()) } catch (error) { this.dispose(); throw error }
  }
  async getSession(): Promise<AuthState> {
    const current = getPublicAuth()
    return { user: current?.user as any ?? null, userId: current?.user?.id ?? null, session: null, accessToken: null, loading: false }
  }
  async login(credentials: Credentials) { this.adopt(await hostAuthTransport().login(credentials)); return this.getSession() }
  async logout() { await hostAuthTransport().logout(); await this.reloadSession() }
  async reloadSession() { this.adopt(await hostAuthTransport().status()) }
  async refreshToken() { this.adopt(await hostAuthTransport().check()); return this.getSession() }
  onAuthStateChange(callback: AuthChangeCallback) { this.listeners.add(callback); callback(getPublicAuth()?.user as any ?? null); return () => { this.listeners.delete(callback) } }
  requiresNetworkAuth() { return false }
}
