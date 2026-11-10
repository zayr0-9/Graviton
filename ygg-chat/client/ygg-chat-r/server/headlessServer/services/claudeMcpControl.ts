import os from 'node:os'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import type { McpServerStatus, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  DEFAULT_HOST_CLAUDE_MCP, type ClaudeMcpServerView, type ClaudeMcpSignInResponse, type ClaudeMcpStatusResponse, type HostClaudeMcpPreferences,
} from '../../../../../shared/claudeNativeMcp.js'
import { claudeProcessEnvironment, resolveClaudeExecutable } from './claudeProcessConfig.js'

// Claude Code's own settings layers, as Claude runs load them (see CLAUDE_SETTING_SOURCES).
const SETTING_SOURCES: NonNullable<Options['settingSources']> = ['user', 'project', 'local']
/** Servers connect in the background; status waits this long for `pending` ones to settle. */
const SETTLE_MS = 12_000
const SETTLE_POLL_MS = 500
const CALL_TIMEOUT_MS = 30_000
/** A sign-in keeps its CLI (and so its OAuth callback listener) this long at most. */
const SIGN_IN_TTL_MS = 5 * 60_000
const SIGN_IN_POLL_MS = 3_000
const MAX_ERROR_CHARS = 500
const MAX_TOOLS = 300
const MAX_NAME = 300
const MAX_CALLBACK_URL = 8_192

/**
 * SDK 0.3.309 runtime methods that its `.d.ts` does not declare (present on CLI 2.1.318). The
 * service feature-detects them and falls back to "sign in from Claude Code" when one is absent.
 */
type ControlQuery = Query & {
  mcpAuthenticate?: (serverName: string, redirectUri?: string, options?: { redirectUriOnly?: boolean }) => Promise<{ authUrl?: string; requiresUserAction?: boolean; callbackExpected?: boolean }>
  mcpSubmitOAuthCallbackUrl?: (serverName: string, callbackUrl: string) => Promise<unknown>
  mcpClearAuth?: (serverName: string) => Promise<unknown>
}
export type ClaudeMcpControlSdk = { query: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query }

export class ClaudeMcpControlError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

interface ControlSession { query: ControlQuery; close: () => void }
interface SignIn { session: ControlSession; callbackExpected: boolean; poll: ReturnType<typeof setInterval>; expiry: ReturnType<typeof setTimeout> }

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClaudeMcpControlError(504, 'claude_mcp_timeout', message)), ms)
  })]).finally(() => clearTimeout(timer))
}

const truncate = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text

function transportOf(server: McpServerStatus): string | null {
  const config = server.config as Record<string, unknown> | undefined
  if (!config) return null
  if (typeof config.type === 'string') return config.type
  return typeof config.command === 'string' ? 'stdio' : null
}

/** The panel's view of a server: name, state and tool names, never its config (headers, env). */
export function claudeMcpServerView(server: McpServerStatus, preferences: HostClaudeMcpPreferences): ClaudeMcpServerView {
  return {
    name: server.name,
    status: server.status,
    source: server.source ?? server.scope ?? null,
    transport: transportOf(server),
    error: server.error ? truncate(server.error, MAX_ERROR_CHARS) : null,
    tools: (server.tools ?? []).slice(0, MAX_TOOLS).map(tool => tool.name),
    hidden: preferences.disabledServers.includes(server.name),
  }
}

function serverName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_NAME || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ClaudeMcpControlError(400, 'claude_mcp_invalid_name', 'A Claude MCP server name is required.')
  }
  return value
}

/** Only web URLs leave the host: the renderer opens this in the system browser. */
function webUrl(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_CALLBACK_URL) throw new ClaudeMcpControlError(400, 'claude_mcp_invalid_url', `Invalid ${what}.`)
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new ClaudeMcpControlError(400, 'claude_mcp_invalid_url', `Invalid ${what}.`) }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ClaudeMcpControlError(400, 'claude_mcp_invalid_url', `The ${what} must be a web address.`)
  return parsed.toString()
}

/**
 * Settings-panel control of Claude Code's own MCP servers: status, in-app sign-in, reconnect and
 * sign-out. Each call starts a short-lived CLI that never gets a prompt (hooks off, nothing
 * persisted), like `ClaudeSessionService.nativeCommand`. A sign-in keeps its CLI until the server
 * connects or SIGN_IN_TTL_MS passes, because the OAuth flow and its callback listener live in it.
 * Credentials land in Claude Code's own store, so every later Claude run (and the terminal CLI)
 * uses them. Graviton never sees a token.
 */
export class ClaudeMcpControlService {
  private readonly signIns = new Map<string, SignIn>()
  private readonly statusInFlight = new Map<string, Promise<ClaudeMcpStatusResponse>>()

  constructor(private readonly deps: {
    preferences: () => HostClaudeMcpPreferences
    sdk?: () => Promise<ClaudeMcpControlSdk>
    executable?: () => Promise<string>
    settleMs?: number
    pollMs?: number
    signInTtlMs?: number
  }) {}

  private preferences(): HostClaudeMcpPreferences {
    try { return this.deps.preferences() } catch { return DEFAULT_HOST_CLAUDE_MCP }
  }

  /** An absolute existing folder, or the home folder (user, local-home and claude.ai servers). */
  async resolveCwd(value: unknown): Promise<string> {
    if (value === undefined || value === null || value === '') return os.homedir()
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new ClaudeMcpControlError(400, 'claude_mcp_invalid_cwd', 'The workspace must be an absolute folder path.')
    const info = await stat(value).catch(() => null)
    if (!info?.isDirectory()) throw new ClaudeMcpControlError(400, 'claude_mcp_invalid_cwd', 'The workspace folder does not exist.')
    return value
  }

  private async open(cwd: string): Promise<ControlSession> {
    const sdk = await (this.deps.sdk ?? (() => import('@anthropic-ai/claude-agent-sdk') as Promise<ClaudeMcpControlSdk>))()
    let executable: string
    try { executable = await (this.deps.executable ?? resolveClaudeExecutable)() }
    catch (error) { throw new ClaudeMcpControlError(503, 'claude_cli_missing', error instanceof Error ? error.message : 'Claude Code CLI is not installed on the host.') }
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    async function* idle(): AsyncGenerator<SDKUserMessage> { await released }
    const preferences = this.preferences()
    // Same MCP configuration a Claude run loads, but every server is listed: hidden ones too.
    const query = sdk.query({ prompt: idle(), options: { cwd, settingSources: SETTING_SOURCES, strictMcpConfig: false,
      persistSession: false, pathToClaudeCodeExecutable: executable, env: claudeProcessEnvironment(),
      settings: { disableAllHooks: true, ...(preferences.claudeAiConnectors ? {} : { disableClaudeAiConnectors: true }) } } }) as ControlQuery
    let closed = false
    return { query, close: () => {
      if (closed) return
      closed = true
      release()
      try { query.close() } catch { /* Already exited. */ }
    } }
  }

  private async rawStatus(query: ControlQuery): Promise<McpServerStatus[]> {
    return withTimeout(query.mcpServerStatus(), CALL_TIMEOUT_MS, 'Claude did not report its MCP servers in time.')
  }

  /** Status once no server is still `pending`, or after the settle budget. */
  private async settledStatus(query: ControlQuery, until?: (servers: McpServerStatus[]) => boolean): Promise<McpServerStatus[]> {
    const deadline = Date.now() + (this.deps.settleMs ?? SETTLE_MS)
    for (;;) {
      const servers = await this.rawStatus(query)
      const settled = until ? until(servers) : !servers.some(server => server.status === 'pending')
      if (settled || Date.now() >= deadline) return servers
      await new Promise(resolve => setTimeout(resolve, this.deps.pollMs ?? SETTLE_POLL_MS))
    }
  }

  private async withSession<T>(cwd: string, work: (query: ControlQuery) => Promise<T>): Promise<T> {
    const session = await this.open(cwd)
    try { return await work(session.query) }
    finally { session.close() }
  }

  async status(cwdInput?: unknown): Promise<ClaudeMcpStatusResponse> {
    const cwd = await this.resolveCwd(cwdInput)
    // Concurrent panels share one CLI per folder.
    const pending = this.statusInFlight.get(cwd)
    if (pending) return pending
    const request = this.withSession(cwd, async query => {
      const servers = await this.settledStatus(query)
      const preferences = this.preferences()
      return { cwd, signInAvailable: typeof query.mcpAuthenticate === 'function',
        servers: servers.filter(server => server.source !== 'sdk').map(server => claudeMcpServerView(server, preferences)) }
    }).finally(() => this.statusInFlight.delete(cwd))
    this.statusInFlight.set(cwd, request)
    return request
  }

  private async find(query: ControlQuery, name: string): Promise<McpServerStatus> {
    const servers = await this.settledStatus(query, list => list.some(server => server.name === name && server.status !== 'pending'))
    const server = servers.find(candidate => candidate.name === name)
    if (!server) throw new ClaudeMcpControlError(404, 'claude_mcp_not_found', `Claude Code has no MCP server named "${name}" for this folder.`)
    return server
  }

  /**
   * Starts Claude's own OAuth flow for one server and returns the address to open in a browser.
   * claude.ai connectors authorize on claude.ai (no callback here); other remote servers return to
   * the CLI's local callback, or the user pastes the final address into `submitCallback`.
   */
  async signIn(nameInput: unknown, cwdInput?: unknown): Promise<ClaudeMcpSignInResponse> {
    const name = serverName(nameInput)
    const cwd = await this.resolveCwd(cwdInput)
    this.endSignIn(name)
    const session = await this.open(cwd)
    try {
      await this.find(session.query, name)
      if (typeof session.query.mcpAuthenticate !== 'function') {
        throw new ClaudeMcpControlError(501, 'claude_mcp_sign_in_unavailable', `This Claude Code version cannot sign in from Graviton. Run \`claude mcp login "${name}"\` in a terminal.`)
      }
      const result = await withTimeout(session.query.mcpAuthenticate(name), CALL_TIMEOUT_MS, 'Claude did not start the sign-in in time.')
      if (!result?.authUrl) throw new ClaudeMcpControlError(502, 'claude_mcp_sign_in_failed', 'Claude did not return a sign-in address for this server.')
      const authUrl = webUrl(result.authUrl, 'sign-in address')
      const callbackExpected = result.callbackExpected === true
      this.watchSignIn(name, session, callbackExpected)
      return { authUrl, callbackExpected }
    } catch (error) {
      session.close()
      throw error
    }
  }

  private watchSignIn(name: string, session: ControlSession, callbackExpected: boolean) {
    let checking = false
    const poll = setInterval(() => {
      if (checking) return
      checking = true
      void (async () => {
        // A claude.ai connector authorizes on claude.ai, which this CLI does not hear about.
        if (!callbackExpected) await session.query.reconnectMcpServer(name).catch(() => {})
        const servers = await this.rawStatus(session.query)
        if (servers.find(server => server.name === name)?.status === 'connected') this.endSignIn(name)
      })().catch(() => {}).finally(() => { checking = false })
    }, this.deps.pollMs ?? SIGN_IN_POLL_MS)
    const expiry = setTimeout(() => this.endSignIn(name), this.deps.signInTtlMs ?? SIGN_IN_TTL_MS)
    poll.unref?.()
    expiry.unref?.()
    this.signIns.set(name, { session, callbackExpected, poll, expiry })
  }

  private endSignIn(name: string) {
    const signIn = this.signIns.get(name)
    if (!signIn) return
    this.signIns.delete(name)
    clearInterval(signIn.poll)
    clearTimeout(signIn.expiry)
    signIn.session.close()
  }

  /** Whether a sign-in for this server is still waiting. */
  signingIn(name: string): boolean { return this.signIns.has(name) }

  /** Hands the browser's final address to a sign-in whose redirect could not reach Claude. */
  async submitCallback(nameInput: unknown, callbackUrlInput: unknown): Promise<void> {
    const name = serverName(nameInput)
    const callbackUrl = webUrl(callbackUrlInput, 'callback address')
    const signIn = this.signIns.get(name)
    if (!signIn) throw new ClaudeMcpControlError(409, 'claude_mcp_no_sign_in', 'No sign-in is waiting for this server. Start the sign-in again.')
    if (typeof signIn.session.query.mcpSubmitOAuthCallbackUrl !== 'function') {
      throw new ClaudeMcpControlError(501, 'claude_mcp_sign_in_unavailable', 'This Claude Code version cannot accept a pasted callback address.')
    }
    await withTimeout(signIn.session.query.mcpSubmitOAuthCallbackUrl(name, callbackUrl), CALL_TIMEOUT_MS, 'Claude did not accept the callback address in time.')
  }

  async reconnect(nameInput: unknown, cwdInput?: unknown): Promise<ClaudeMcpServerView> {
    const name = serverName(nameInput)
    const cwd = await this.resolveCwd(cwdInput)
    return this.withSession(cwd, async query => {
      await this.find(query, name)
      let failure: string | null = null
      await withTimeout(query.reconnectMcpServer(name), CALL_TIMEOUT_MS, 'Claude did not reconnect the server in time.')
        .catch(error => { failure = error instanceof Error ? error.message : String(error) })
      const server = (await this.rawStatus(query)).find(candidate => candidate.name === name)
      if (!server) throw new ClaudeMcpControlError(404, 'claude_mcp_not_found', `Claude Code has no MCP server named "${name}".`)
      const view = claudeMcpServerView(server, this.preferences())
      return failure && !view.error ? { ...view, error: truncate(failure, MAX_ERROR_CHARS) } : view
    })
  }

  /** Clears the server's stored OAuth credentials in Claude Code (`claude mcp logout`). */
  async signOut(nameInput: unknown, cwdInput?: unknown): Promise<void> {
    const name = serverName(nameInput)
    const cwd = await this.resolveCwd(cwdInput)
    this.endSignIn(name)
    await this.withSession(cwd, async query => {
      await this.find(query, name)
      if (typeof query.mcpClearAuth !== 'function') {
        throw new ClaudeMcpControlError(501, 'claude_mcp_sign_in_unavailable', `This Claude Code version cannot sign out from Graviton. Run \`claude mcp logout "${name}"\` in a terminal.`)
      }
      await withTimeout(query.mcpClearAuth(name), CALL_TIMEOUT_MS, 'Claude did not sign out in time.')
    })
  }

  dispose(): void {
    for (const name of [...this.signIns.keys()]) this.endSignIn(name)
  }
}
