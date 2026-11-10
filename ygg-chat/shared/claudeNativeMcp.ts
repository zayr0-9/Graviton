/**
 * Claude Code's own MCP servers in Claude chats (v1). Claude Code defines the servers
 * (`claude mcp add`, `.mcp.json`, plugins, claude.ai connectors); Graviton only chooses whether
 * Claude loads them and which ones the model may use. Graviton's own MCP servers are not
 * passed to Claude yet.
 */
export interface HostClaudeMcpPreferences {
  /** Load Claude Code's MCP configuration in Claude runs; off keeps the strict, empty MCP set. */
  enabled: boolean
  /** Include the claude.ai connectors of the signed-in Claude account. */
  claudeAiConnectors: boolean
  /** Server names, as Claude reports them, whose tools Graviton hides from the model. */
  disabledServers: string[]
}

export const DEFAULT_HOST_CLAUDE_MCP: HostClaudeMcpPreferences = { enabled: false, claudeAiConnectors: true, disabledServers: [] }

const MAX_DISABLED_SERVERS = 500
const MAX_SERVER_NAME = 300

export function validateHostClaudeMcpPreferences(input: unknown): HostClaudeMcpPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Claude MCP settings')
  const value = { ...DEFAULT_HOST_CLAUDE_MCP, ...input } as Record<string, unknown>
  if (Object.keys(value).some(key => !Object.prototype.hasOwnProperty.call(DEFAULT_HOST_CLAUDE_MCP, key))) throw new Error('Unknown Claude MCP setting')
  if (typeof value.enabled !== 'boolean' || typeof value.claudeAiConnectors !== 'boolean') throw new Error('Invalid Claude MCP switch')
  const disabled = value.disabledServers
  if (!Array.isArray(disabled) || disabled.length > MAX_DISABLED_SERVERS ||
    disabled.some(name => typeof name !== 'string' || !name || name.length > MAX_SERVER_NAME || /[\x00-\x1f\x7f]/.test(name))) {
    throw new Error('Invalid Claude MCP server list')
  }
  return { enabled: value.enabled, claudeAiConnectors: value.claudeAiConnectors, disabledServers: [...new Set(disabled as string[])] }
}

/**
 * The server segment of Claude's `mcp__<server>__<tool>` names. Mirrors the CLI (2.1.318): every
 * character outside `[a-zA-Z0-9_-]` becomes `_`, and for claude.ai connectors repeated `_` collapse
 * and edge `_` drop ("claude.ai Vega GP (UAT env)" -> "claude_ai_Vega_GP_UAT_env").
 */
export function claudeMcpToolServerName(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return name.startsWith('claude.ai ') ? replaced.replace(/_+/g, '_').replace(/^_|_$/g, '') : replaced
}

/** Where a Claude MCP tool name's server matches a disabled server (`mcp__<server>` rule). */
export function claudeMcpServerRule(name: string): string {
  return `mcp__${claudeMcpToolServerName(name)}`
}

/** The MCP part of a Claude run's SDK options. */
export interface ClaudeMcpLaunchOptions {
  strictMcpConfig: boolean
  mcpServers?: Record<string, never>
  disallowedTools?: string[]
  /** Merged into the run's flag `settings`. */
  settings?: { disableClaudeAiConnectors: true }
}

/**
 * Off: only the (empty) servers Graviton passes, ignoring all Claude MCP configuration.
 * On: Claude's own configuration loads; disabled servers still connect, but a `mcp__<server>`
 * deny rule removes their tools. Changing that list changes the tool prefix, so the next turn
 * re-reads the cached transcript once.
 */
export function claudeMcpLaunchOptions(preferences: HostClaudeMcpPreferences | null | undefined): ClaudeMcpLaunchOptions {
  if (!preferences?.enabled) return { strictMcpConfig: true, mcpServers: {} }
  const disallowedTools = [...new Set(preferences.disabledServers.map(claudeMcpServerRule))].sort()
  return {
    strictMcpConfig: false,
    ...(disallowedTools.length ? { disallowedTools } : {}),
    ...(preferences.claudeAiConnectors ? {} : { settings: { disableClaudeAiConnectors: true } }),
  }
}

export type ClaudeMcpServerState = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

/** A Claude MCP server as the settings panel shows it. Never carries its config (headers, env). */
export interface ClaudeMcpServerView {
  name: string
  status: ClaudeMcpServerState
  /** sdk | plugin | user | project | local | dynamic | managed | enterprise | claudeai | agent | … */
  source: string | null
  transport: string | null
  error: string | null
  tools: string[]
  /** Hidden from the model by Graviton (`disabledServers`). */
  hidden: boolean
}

export interface ClaudeMcpStatusResponse {
  servers: ClaudeMcpServerView[]
  /** Folder Claude read project servers from. */
  cwd: string
  /** The installed CLI offers in-app sign-in (`mcpAuthenticate`). */
  signInAvailable: boolean
}

export interface ClaudeMcpSignInResponse {
  authUrl: string
  /** The browser must return to Claude's own callback; if it cannot, paste the final URL back. */
  callbackExpected: boolean
}
