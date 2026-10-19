import type { AuthProvider } from './types'
import { bootstrapHostRuntime } from '../../services/hostRuntimeBootstrap'
export type { AuthChangeCallback, AuthProvider, AuthState, Credentials, Session, User } from './types'
let pending: Promise<AuthProvider> | null = null
export function getAuthProvider(): Promise<AuthProvider> {
  if (!pending) pending = (async () => {
    await bootstrapHostRuntime()
    const { ManagedAuthProvider } = await import('./managed')
    const provider = new ManagedAuthProvider()
    await provider.initialize()
    return provider
  })().catch(error => { pending = null; throw error })
  return pending
}
export function resetAuthProvider() {
  const previous = pending
  pending = null
  void previous?.then(provider => provider.dispose?.()).catch(() => undefined)
}
