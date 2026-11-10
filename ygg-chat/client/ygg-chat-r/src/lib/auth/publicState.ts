import type { HostAuthState } from '../../../../../shared/hostRuntime'
export interface PublicAuthState extends HostAuthState { epoch?: string }
let current: PublicAuthState | null = null
export const getPublicAuth = () => current
export const setPublicAuth = (state: PublicAuthState) => { current = state }
