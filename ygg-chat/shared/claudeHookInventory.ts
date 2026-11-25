export type ClaudeHookSource = 'project' | 'local' | 'user'

export interface ClaudeHookDeclaration {
  event: string
  matcher: string | null
  type: string
}

export interface ClaudeHookSettingsSource {
  source: ClaudeHookSource
  file: string
  status: 'missing' | 'unreadable' | 'invalid' | 'limited' | 'read'
  hooks: ClaudeHookDeclaration[]
}

export interface ClaudeHookInventory {
  cwd: string | null
  sources: ClaudeHookSettingsSource[]
}
