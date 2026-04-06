import type { WebSocket } from 'ws'

export type LspServerTransport = 'stdio'

export type LspSessionStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error'

export interface LspServerDefinition {
  id: string
  label: string
  transport: LspServerTransport
  languages: string[]
  commandCandidates: string[]
  args: string[]
  rootMarkers: string[]
  initializationOptions?: unknown
  settings?: unknown
  env?: Record<string, string>
}

export interface ResolvedLspCommand {
  command: string
  args: string[]
  source: 'configured' | 'env' | 'global-npm' | 'path'
}

export interface LspResolveResult {
  available: boolean
  filePath: string
  fileUri: string
  lspLanguageId: string | null
  serverId: string | null
  sessionKey: string | null
  workspacePath: string | null
  workspaceUri: string | null
  command: string | null
  commandSource: ResolvedLspCommand['source'] | null
  args: string[]
  initializationOptions?: unknown
  settings?: unknown
  reason?: string | null
}

export interface LspSessionAttachOptions {
  serverId: string
  workspacePath: string
  clientId?: string | null
  socket: WebSocket
}

export interface LspSessionSummary {
  sessionKey: string
  serverId: string
  workspacePath: string
  workspaceUri: string
  status: LspSessionStatus
  pid: number | null
  command: string | null
  commandSource: ResolvedLspCommand['source'] | null
  args: string[]
  attachedClientId: string | null
  attached: boolean
  lastActivityAt: string | null
  startedAt: string | null
  lastError: string | null
  restartCount: number
  stderrTail: string[]
}

export interface LspServerSummary {
  id: string
  label: string
  languages: string[]
  rootMarkers: string[]
  preferredCommand: string | null
  commandSource: ResolvedLspCommand['source'] | null
  available: boolean
  reason?: string | null
}

export interface LspFileContextSymbol {
  name: string
  kind: number | null
  detail?: string | null
  range: {
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
  }
  children?: LspFileContextSymbol[]
}

export interface LspFileContextDiagnostic {
  message: string
  severity?: number | null
  source?: string | null
  code?: string | number | null
  range: {
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
  }
}

export interface LspFileContext {
  available: boolean
  filePath: string
  fileUri: string
  serverId: string | null
  lspLanguageId: string | null
  workspacePath: string | null
  command: string | null
  commandSource: ResolvedLspCommand['source'] | null
  symbols: LspFileContextSymbol[]
  diagnostics: LspFileContextDiagnostic[]
  reason?: string | null
}
