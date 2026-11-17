import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../shared/builtinToolDefinitions.js'
import { CLAUDE_GRAVITON_TOOL_NAMES, GRAVITON_MCP_SERVER } from '../../../../../shared/claudeGravitonTools.js'
export { CLAUDE_GRAVITON_TOOL_NAMES, GRAVITON_MCP_SERVER, claudeGravitonToolName, gravitonToolName } from '../../../../../shared/claudeGravitonTools.js'

/**
 * Graviton's own tools in Claude chats. Claude Code takes host tools only as MCP tools, so
 * Graviton serves them from an in-process MCP server (`type: 'sdk'`, no child process, no port)
 * named `graviton`; Claude sees `mcp__graviton__<tool>`.
 *
 * The list follows the Settings → Tools switches live. `tools/list` reads the switches each time
 * Claude asks, and a change is announced with `notifications/tools/list_changed`. The server
 * records what it last answered, so a run can tell whether Claude has the current list and wait
 * for it (`sync`). Claude cannot reconnect an in-process server (CLI 2.1.323 answers
 * `reconnectMcpServer` with "SDK servers should be handled in print.ts"); a run whose CLI never
 * refreshes relaunches it instead. Which tools are offered: `shared/claudeGravitonTools.ts`.
 */

export interface GravitonToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, any>
}

const DEFAULT_ENABLED = new Map(BUILTIN_TOOL_DEFINITIONS.map(tool => [tool.name, tool.enabled]))

/**
 * The Graviton tools Claude may use now: offered to Claude, available on this host, and switched
 * on in Settings (a tool never switched keeps its default).
 */
export function enabledGravitonTools(available: GravitonToolDefinition[], states: Record<string, boolean> | null | undefined): GravitonToolDefinition[] {
  return available.filter(tool => CLAUDE_GRAVITON_TOOL_NAMES.has(tool.name)
    && (states?.[tool.name] ?? DEFAULT_ENABLED.get(tool.name) ?? false))
}

/** What a tool call returns to Claude (model text) and to Graviton's own row (persisted text). */
export interface GravitonToolOutcome {
  /** The CallToolResult text Claude reads. */
  text: string
  isError: boolean
}

export interface GravitonToolCall {
  name: string
  arguments: Record<string, unknown>
  /** Claude's tool_use id (`_meta["claudecode/toolUseId"]`), when the CLI sends it. */
  toolUseId: string | null
  /** Aborted when Claude cancels the call (`notifications/cancelled`) or the server closes. */
  signal: AbortSignal
}

/** The transport the Agent SDK hands an in-process server (`instance.connect(transport)`). */
export interface SdkMcpTransport {
  onmessage?: (message: any) => void
  onclose?: () => void
  send(message: unknown): Promise<void>
  start?(): Promise<void>
  close?(): Promise<void>
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const fingerprint = (tools: GravitonToolDefinition[]) => tools.map(tool => tool.name).sort().join('\n')

/**
 * A minimal MCP server for the SDK transport: initialize, ping, tools/list, tools/call and
 * cancellation. Graviton's schemas are JSON Schema already; the SDK's `tool()` helper would
 * need Zod shapes, and `@modelcontextprotocol/sdk` is not a direct dependency of the app.
 */
export class GravitonMcpServer {
  private transport: SdkMcpTransport | null = null
  /** Fingerprint of the list Claude last received; null before its first tools/list. */
  private served: string | null = null
  private servedWaiters = new Set<() => void>()
  private readonly calls = new Map<string | number, AbortController>()

  constructor(private readonly options: {
    tools: () => GravitonToolDefinition[]
    call: (call: GravitonToolCall) => Promise<GravitonToolOutcome>
  }) {}

  async connect(transport: SdkMcpTransport): Promise<void> {
    this.transport = transport
    transport.onmessage = message => this.receive(message)
    const previous = transport.onclose
    transport.onclose = () => { previous?.(); this.closed() }
    await transport.start?.()
  }

  async close(): Promise<void> {
    const transport = this.transport
    this.closed()
    await transport?.close?.()
  }

  get connected(): boolean { return this.transport !== null }

  /** Claude's tool list is the current one. */
  inSync(): boolean {
    return this.served !== null && this.served === fingerprint(this.currentTools())
  }

  /**
   * Bring Claude's tool list up to date: announce a change and wait until Claude lists again.
   * True once Claude holds the current list; false when it did not ask in time.
   */
  async sync(timeoutMs: number): Promise<boolean> {
    if (!this.transport) return false
    if (this.inSync()) return true
    let release!: () => void
    const listed = new Promise<void>(resolve => { release = resolve })
    this.servedWaiters.add(release)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      await Promise.race([listed, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      this.servedWaiters.delete(release)
    }
    return this.inSync()
  }

  /** Announce a change when Claude's list is stale; no wait. */
  notifyIfChanged(): void {
    if (!this.transport || this.served === null || this.inSync()) return
    void this.transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }).catch(() => {})
  }

  private currentTools(): GravitonToolDefinition[] {
    try { return this.options.tools() }
    catch (error) {
      console.warn('[ClaudeGravitonTools] tool list unavailable', error instanceof Error ? error.message : error)
      return []
    }
  }

  private closed() {
    this.transport = null
    for (const controller of this.calls.values()) controller.abort(new Error('The Graviton tool server closed'))
    this.calls.clear()
    for (const release of this.servedWaiters) release()
    this.servedWaiters.clear()
  }

  private reply(id: string | number, payload: { result: unknown } | { error: { code: number; message: string } }) {
    void this.transport?.send({ jsonrpc: '2.0', id, ...payload }).catch(() => {})
  }

  private receive(message: any) {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') return // a response: none expected
    const id = message.id
    if (id === undefined || id === null) {
      if (message.method === 'notifications/cancelled') {
        this.calls.get(message.params?.requestId)?.abort(new Error(String(message.params?.reason ?? 'Claude cancelled the call')))
      }
      return
    }
    switch (message.method) {
      case 'initialize':
        this.reply(id, { result: {
          protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: GRAVITON_MCP_SERVER, version: '1.0.0' },
        } })
        return
      case 'ping':
        this.reply(id, { result: {} })
        return
      case 'tools/list': {
        const tools = this.currentTools()
        this.served = fingerprint(tools)
        this.reply(id, { result: { tools: tools.map(tool => ({ name: tool.name, description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } })) } })
        for (const release of this.servedWaiters) release()
        return
      }
      case 'tools/call':
        void this.call(id, message.params)
        return
      default:
        this.reply(id, { error: { code: -32601, message: `Method not found: ${message.method}` } })
    }
  }

  private async call(id: string | number, params: any) {
    const name = typeof params?.name === 'string' ? params.name : ''
    const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
    const toolUseId = typeof params?._meta?.['claudecode/toolUseId'] === 'string' ? params._meta['claudecode/toolUseId'] : null
    const controller = new AbortController()
    this.calls.set(id, controller)
    let outcome: GravitonToolOutcome
    try {
      // A list Claude has not refreshed yet can still name a tool switched off since.
      if (!this.currentTools().some(tool => tool.name === name)) {
        outcome = { text: `The Graviton tool "${name}" is turned off in Graviton's Settings → Tools, or not available on this host.`, isError: true }
      } else {
        outcome = await this.options.call({ name, arguments: args, toolUseId, signal: controller.signal })
      }
    } catch (error) {
      outcome = { text: error instanceof Error ? error.message : String(error), isError: true }
    } finally {
      this.calls.delete(id)
    }
    // A cancelled request gets no response (MCP cancellation).
    if (controller.signal.aborted) return
    this.reply(id, { result: { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError } })
  }
}

/** The MCP server config for the SDK's `mcpServers`. */
export function gravitonMcpServerConfig(server: GravitonMcpServer) {
  // The SDK only calls `instance.connect(transport)`; its type names the MCP SDK's McpServer.
  return { type: 'sdk' as const, name: GRAVITON_MCP_SERVER, instance: server as any }
}

/** A Graviton tool result as Claude reads it: the model channel when there is one, else the persisted copy. */
export function gravitonResultText(result: any): string {
  const pick = result && typeof result === 'object' && !Array.isArray(result)
    ? Object.prototype.hasOwnProperty.call(result, 'modelContent') ? result.modelContent
      : Object.prototype.hasOwnProperty.call(result, 'persistedContent') ? result.persistedContent
        : Object.prototype.hasOwnProperty.call(result, 'displayContent') ? result.displayContent : result
    : result
  if (typeof pick === 'string') return pick
  try { return JSON.stringify(pick ?? null) } catch { return String(pick) }
}
