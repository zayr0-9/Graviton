import type { AuthSnapshot } from './auth.js'

export const HOST_CLIENT_PROTOCOL = 1
export interface HostAuthState {
  codex: AuthSnapshot
  /** Always the single local user (fully-local plan D4). */
  user: { id: string; email?: string | null }
  epoch?: string
}
export interface HostRuntimeInfo {
  protocol: number
  epoch: string
  hostId: string
  auth: HostAuthState
  capabilities: { browserUi: boolean; sharedRuns: boolean }
  network?: { bindHost: string | null; port: number | null; exposure: string; deviceAuthentication: false }
}
