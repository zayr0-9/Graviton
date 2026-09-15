import type { AuthProvider } from './types'
export type { AuthChangeCallback, AuthProvider, AuthState, Credentials, Session, User } from './types'
let pending: Promise<AuthProvider> | null = null
export function getAuthProvider(): Promise<AuthProvider> {
  if (!pending) pending = (async () => {
    const { ManagedAuthProvider } = await import('./managed')
    const provider = new ManagedAuthProvider()
    await provider.initialize()
    return provider
  })().catch(error => { pending = null; throw error })
  return pending
}
export function resetAuthProvider() { pending = null }
