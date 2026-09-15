import type { AuthSnapshot } from '../../../../../shared/auth'
export interface PublicAuthState { app: AuthSnapshot; codex: AuthSnapshot; user: { id: string; email?: string | null } | null }
let current: PublicAuthState | null = null
export const getPublicAuth = () => current
export const setPublicAuth = (state: PublicAuthState) => { current = state }
