import { isBrowserClient } from '../../platform/clientCapabilities'
import type { PublicAuthState } from './publicState'
import type { Credentials } from './types'

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/host/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('Could not connect to the Graviton host. Try again when the desktop app is running.')
  return response.json()
}

export function hostAuthTransport() {
  if (!isBrowserClient) return window.electronAPI!.auth
  return {
    status: () => request<PublicAuthState>('status'),
    check: () => request<PublicAuthState>('check', {}),
    login: (credentials: Credentials) => request<PublicAuthState>('local', credentials),
    logout: () => request<PublicAuthState>('logout', {}),
    onChanged: (listener: (state: PublicAuthState) => void) => {
      const events = new EventSource('/api/host/auth/events')
      events.onmessage = event => {
        try { listener(JSON.parse(event.data)) } catch { /* A reconnect delivers a fresh full snapshot. */ }
      }
      return () => events.close()
    },
    onLoginError: (_listener: (message: string) => void) => () => {},
    start: async (_provider: string, _oob?: boolean): Promise<{ url: string }> => { throw new Error('Complete cloud sign-in on the Electron host; this browser will update automatically.') },
    code: async (_code: string) => { throw new Error('Enter the sign-in code on the Electron host.') },
    cancel: async () => true,
    openExternal: async (_url: string) => ({ success: false }),
  }
}

export const disconnectHostCodex = () => request<PublicAuthState>('codex/disconnect', {})
export const readHostCodexUsage = <T>() => request<T>('codex/usage')
