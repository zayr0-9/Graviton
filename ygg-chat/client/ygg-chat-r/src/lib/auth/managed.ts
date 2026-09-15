import { store } from '../../store/store'
import { uiActions } from '../../features/ui'
import { buildChatErrorEnvelope } from '../../../../../shared/chatErrors'
import { getPublicAuth, setPublicAuth, type PublicAuthState } from './publicState'
import type { AuthProvider, AuthState, Credentials, AuthChangeCallback } from './types'
export class ManagedAuthProvider implements AuthProvider {
  private listeners = new Set<AuthChangeCallback>()
  private adopt = (value: PublicAuthState) => {
    const current = getPublicAuth()
    if (current && value.app.version < current.app.version) return
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
    const api = window.electronAPI!.auth
    const read = (key: string) => { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
    const raw = read('supabase-auth-token')
    await api.migrate({ app: raw ? { session: raw.currentSession || raw.session || raw } : null, codex: read('openai_chatgpt_tokens') })
    localStorage.removeItem('supabase-auth-token')
    localStorage.removeItem('openai_chatgpt_tokens')
    api.onChanged(this.adopt)
    window.addEventListener('online', () => { void api.check().then(this.adopt).catch(() => undefined) })
    this.adopt(await api.status())
  }
  async getSession(): Promise<AuthState> {
    const current = getPublicAuth()
    return { user: current?.user as any ?? null, userId: current?.user?.id ?? null, session: null, accessToken: null, loading: false }
  }
  async login(credentials: Credentials) { this.adopt(await window.electronAPI!.auth.login(credentials)); return this.getSession() }
  async logout() { await window.electronAPI!.auth.logout(); await this.reloadSession() }
  async reloadSession() { this.adopt(await window.electronAPI!.auth.status()) }
  async refreshToken() { this.adopt(await window.electronAPI!.auth.check()); return this.getSession() }
  onAuthStateChange(callback: AuthChangeCallback) { this.listeners.add(callback); callback(getPublicAuth()?.user as any ?? null); return () => { this.listeners.delete(callback) } }
  requiresNetworkAuth() { return false }
}
