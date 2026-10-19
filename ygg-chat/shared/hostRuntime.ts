import type { AuthSnapshot } from './auth.js'

export const HOST_CLIENT_PROTOCOL = 1
export interface HostAuthState {
  app: AuthSnapshot
  codex: AuthSnapshot
  user: { id: string; email?: string | null } | null
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
