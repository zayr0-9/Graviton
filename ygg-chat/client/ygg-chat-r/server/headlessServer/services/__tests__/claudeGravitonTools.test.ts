import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_GRAVITON_TOOL_NAMES, GravitonMcpServer, claudeGravitonToolName, enabledGravitonTools, gravitonResultText, gravitonToolName, type SdkMcpTransport } from '../claudeGravitonTools.js'
import { ClaudeSessionService } from '../claudeSessionService.js'
import { DecisionBroker } from '../decisionBroker.js'
import { shouldBypassPermission } from '../chatOrchestrator.js'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../../../../shared/builtinToolDefinitions.js'

/** The CLI end of the SDK transport: requests by id, everything the server sent. */
function cliTransport() {
  const sent: any[] = []
  const waiting = new Map<string | number, (message: any) => void>()
  const transport: SdkMcpTransport = {
    async send(message: any) { sent.push(message); waiting.get(message.id)?.(message); waiting.delete(message.id) },
  }
  let next = 1
  const request = (method: string, params: any = {}) => new Promise<any>(resolve => {
    const id = next++
    waiting.set(id, resolve)
    transport.onmessage!({ jsonrpc: '2.0', id, method, params })
  })
  const notify = (method: string, params: any = {}) => transport.onmessage!({ jsonrpc: '2.0', method, params })
  return { transport, sent, request, notify }
}

const definitions = BUILTIN_TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))

describe('Graviton tool names and selection', () => {
  it('maps Claude MCP names to Graviton tool names and back', () => {
    expect(gravitonToolName('mcp__graviton__theme_manager')).toBe('theme_manager')
    expect(gravitonToolName('mcp__graviton__')).toBeNull()
    expect(gravitonToolName('mcp__other__theme_manager')).toBeNull()
    expect(gravitonToolName('Read')).toBeNull()
    expect(claudeGravitonToolName('fetch_chats')).toBe('mcp__graviton__fetch_chats')
  })

  it('offers only tools Claude has no twin for, available here and switched on', () => {
    const names = (states: Record<string, boolean>) => enabledGravitonTools(definitions, states).map(tool => tool.name).sort()
    // Claude's own Read/Bash/WebSearch twins never appear.
    expect(names({})).toEqual([...CLAUDE_GRAVITON_TOOL_NAMES].sort())
    expect(names({ theme_manager: false })).not.toContain('theme_manager')
    // A tool switched off by default stays off until switched on.
    expect(enabledGravitonTools([{ name: 'theme_manager' }], {}).length).toBe(1)
    expect(names({ read_file: true, bash: true, brave_search: true })).not.toEqual(expect.arrayContaining(['read_file']))
    // A tool this host cannot run (browse_web without a browser engine) is never offered.
    expect(enabledGravitonTools(definitions.filter(tool => tool.name !== 'browse_web'), {}).map(tool => tool.name)).not.toContain('browse_web')
  })

  it('gives Claude the model channel of a split result', () => {
    expect(gravitonResultText({ modelContent: 'for the model', persistedContent: { big: true } })).toBe('for the model')
    expect(gravitonResultText({ persistedContent: { ok: 1 } })).toBe('{"ok":1}')
    expect(gravitonResultText('plain')).toBe('plain')
    expect(gravitonResultText({ success: true })).toBe('{"success":true}')
  })
})

describe('GravitonMcpServer', () => {
  const setup = (tools: () => any[], call = vi.fn(async () => ({ text: 'done', isError: false }))) => {
    const server = new GravitonMcpServer({ tools, call })
    const cli = cliTransport()
    return { server, call, ...cli }
  }

  it('answers initialize, ping and tools/list with JSON Schema tools', async () => {
    let enabled = ['theme_manager']
    const { server, transport, request } = setup(() => definitions.filter(tool => enabled.includes(tool.name)))
    await server.connect(transport)
    expect((await request('initialize', { protocolVersion: '2025-11-25' })).result).toMatchObject({
      protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'graviton' } })
    expect((await request('ping')).result).toEqual({})
    expect(server.inSync()).toBe(false)
    const listed = await request('tools/list')
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(['theme_manager'])
    expect(listed.result.tools[0].inputSchema).toMatchObject({ type: 'object' })
    expect(server.inSync()).toBe(true)
    enabled = ['theme_manager', 'fetch_chats']
    expect(server.inSync()).toBe(false)
    expect((await request('resources/list')).error).toMatchObject({ code: -32601 })
  })

  it('syncs by announcing a change and waiting for Claude to list again', async () => {
    let enabled = ['theme_manager']
    const { server, transport, request, sent } = setup(() => definitions.filter(tool => enabled.includes(tool.name)))
    await server.connect(transport)
    await request('tools/list')
    enabled = ['fetch_chats']
    const synced = server.sync(1_000)
    await vi.waitFor(() => expect(sent.some(message => message.method === 'notifications/tools/list_changed')).toBe(true))
    await request('tools/list')
    await expect(synced).resolves.toBe(true)
    // Already current: no announcement.
    const before = sent.length
    await expect(server.sync(1_000)).resolves.toBe(true)
    expect(sent.length).toBe(before)
  })

  it('reports a CLI that never lists again', async () => {
    let enabled = ['theme_manager']
    const { server, transport, request } = setup(() => definitions.filter(tool => enabled.includes(tool.name)))
    await server.connect(transport)
    await request('tools/list')
    enabled = []
    await expect(server.sync(20)).resolves.toBe(false)
  })

  it('announces a live change only when Claude holds a stale list', async () => {
    let enabled = ['theme_manager']
    const { server, transport, request, sent } = setup(() => definitions.filter(tool => enabled.includes(tool.name)))
    await server.connect(transport)
    server.notifyIfChanged() // Claude has not listed yet: it will read the current list anyway.
    await request('tools/list')
    server.notifyIfChanged()
    expect(sent.filter(message => message.method === 'notifications/tools/list_changed')).toHaveLength(0)
    enabled = []
    server.notifyIfChanged()
    expect(sent.filter(message => message.method === 'notifications/tools/list_changed')).toHaveLength(1)
  })

  it('calls the run with the tool_use id Claude attaches, and refuses tools switched off since', async () => {
    let enabled = ['theme_manager']
    const { server, transport, request, call } = setup(() => definitions.filter(tool => enabled.includes(tool.name)))
    await server.connect(transport)
    const reply = await request('tools/call', { name: 'theme_manager', arguments: { action: 'list' }, _meta: { 'claudecode/toolUseId': 'toolu_1' } })
    expect(reply.result).toEqual({ content: [{ type: 'text', text: 'done' }], isError: false })
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ name: 'theme_manager', arguments: { action: 'list' }, toolUseId: 'toolu_1' }))
    enabled = []
    const refused = await request('tools/call', { name: 'theme_manager', arguments: {} })
    expect(refused.result.isError).toBe(true)
    expect(refused.result.content[0].text).toContain('turned off')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('aborts a call Claude cancels and sends no response for it', async () => {
    let signal: AbortSignal | undefined
    const { server, transport, notify, sent } = setup(() => definitions.filter(tool => tool.name === 'theme_manager'),
      vi.fn(async (call: any) => { signal = call.signal; await new Promise(resolve => call.signal.addEventListener('abort', resolve)); return { text: 'late', isError: false } }))
    await server.connect(transport)
    transport.onmessage!({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'theme_manager', arguments: {} } })
    await vi.waitFor(() => expect(signal).toBeDefined())
    notify('notifications/cancelled', { requestId: 7, reason: 'user interrupt' })
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent.some(message => message.id === 7)).toBe(false)
  })
})

describe('Graviton tools in a Claude run', () => {
  function fixture(options: { states?: Record<string, boolean>; operationMode?: 'plan' | 'execute'; autoApprove?: boolean } = {}) {
    const rows: any[] = []
    const state: any = {}
    const sessions = { branch: vi.fn(() => state.branch), checkpoint: vi.fn(() => state.checkpoint), reserve: vi.fn(),
      session: vi.fn((_lineage, session_id, status) => { state.branch = { session_id, state: status } }), record: vi.fn() }
    let states = options.states ?? {}
    const execute = vi.fn(async (_call: any, _context: any) => ({ success: true, persistedContent: { themes: ['dusk'] }, modelContent: 'Themes: dusk' }))
    const cli: { listed?: any; called?: any; server?: any } = {}
    const sdk = {
      query: vi.fn(({ options: queryOptions }: any) => {
        const server = queryOptions.mcpServers?.graviton?.instance
        const transport = cliTransport()
        async function* events() {
          await server.connect(transport.transport)
          cli.server = server
          cli.listed = await transport.request('tools/list')
          yield { type: 'assistant', uuid: 'a1', session_id: 's', parent_tool_use_id: null,
            message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__graviton__theme_manager', input: { action: 'list' } }] } }
          cli.called = await transport.request('tools/call', { name: 'theme_manager', arguments: { action: 'list' }, _meta: { 'claudecode/toolUseId': 'toolu_1' } })
          yield { type: 'user', uuid: 'r1', session_id: 's', parent_tool_use_id: null,
            message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: cli.called.result.content, is_error: cli.called.result.isError }] } }
          yield { type: 'assistant', uuid: 'a2', session_id: 's', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'You have dusk.' }] } }
          yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' }
        }
        return Object.assign(events(), { close: vi.fn() })
      }),
      forkSession: vi.fn(), getSessionMessages: vi.fn(async () => []),
    }
    const sink = { persistAssistantMessage: vi.fn((draft: any) => { const row = { ...draft, id: `row${rows.length}` }; rows.push(row); return row }),
      updateAssistantToolState: vi.fn((id: string, update: any) => { const row = rows.find(row => row.id === id); Object.assign(row, { content_blocks: update.contentBlocks }); return { ...row, ...update } }) }
    const broker = new DecisionBroker()
    broker.initSession('stream', { autoApproveAll: options.autoApprove ?? true })
    const emit = vi.fn()
    const service = new ClaudeSessionService({ sessions: sessions as any, broker, executable: async () => '/mock/claude', sdk: async () => sdk as any, hookRuns: null,
      messages: { get: vi.fn(() => null), updateClaudeProjection: vi.fn((id: string, content: string, content_blocks: any, meta: any) => ({ id, content, content_blocks, meta })) } as any,
      gravitonTools: { available: () => enabledGravitonTools(definitions, states), execute, bypassPermission: shouldBypassPermission } })
    const input: any = { request: { conversationId: 'c', provider: 'Claude Code', modelName: 'claude-sonnet-5-5', content: 'which themes?', streamId: 'stream', operationMode: options.operationMode ?? 'execute' },
      lineageId: 'l', userMessage: { id: 'u' }, parentId: 'u', sourceMessageId: null, fork: false, cwd: '/workspace', sink, emit }
    return { service, input, sdk, execute, cli, rows, emit, broker, setStates: (next: Record<string, boolean>) => { states = next } }
  }

  it('serves enabled Graviton tools and runs a call through Graviton\'s executor, rendered as Graviton\'s own tool', async () => {
    const f = fixture()
    await f.service.run(f.input)
    expect(f.sdk.query.mock.calls[0][0].options).toMatchObject({ strictMcpConfig: true, mcpServers: { graviton: { type: 'sdk', name: 'graviton' } } })
    const offered = f.cli.listed.result.tools.map((tool: any) => tool.name)
    expect(offered).toContain('theme_manager')
    expect(offered).not.toContain('read_file')
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'toolu_1', name: 'theme_manager', arguments: { action: 'list' } }),
      expect.objectContaining({ conversationId: 'c', streamId: 'stream', lineageId: 'l', rootPath: '/workspace', operationMode: 'execute', messageId: 'row0' }))
    // Claude reads the model channel; Graviton's row keeps the persisted copy its tool card reads.
    expect(f.cli.called.result).toEqual({ content: [{ type: 'text', text: 'Themes: dusk' }], isError: false })
    const blocks = f.rows[0].content_blocks
    expect(blocks.find((block: any) => block.type === 'tool_use')).toMatchObject({ id: 'toolu_1', name: 'theme_manager' })
    expect(blocks.find((block: any) => block.type === 'tool_result')).toMatchObject({ tool_use_id: 'toolu_1', content: '{"themes":["dusk"]}', is_error: false })
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_execution', status: 'started', toolName: 'theme_manager' }))
  })

  it('keeps Graviton tools out of a run whose service has none wired', async () => {
    const f = fixture()
    const sdk = { query: vi.fn(() => Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false, session_id: 's' } })(), { close: vi.fn() })) }
    const service = new ClaudeSessionService({ sessions: { branch: vi.fn(), checkpoint: vi.fn(), reserve: vi.fn(), session: vi.fn(), record: vi.fn() } as any,
      messages: {} as any, executable: async () => '/mock/claude', sdk: async () => sdk as any, hookRuns: null })
    await service.run(f.input).catch(() => {})
    expect((sdk.query.mock.calls[0] as any[])[0].options.mcpServers).toEqual({})
  })

  it('denies a tool switched off in Settings, ahead of Claude\'s own allow rules', async () => {
    const f = fixture({ states: { theme_manager: false } })
    await f.service.run(f.input)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.cli.called.result.isError).toBe(true)
    const options = f.sdk.query.mock.calls[0][0].options
    const guard = options.hooks.PreToolUse.at(-1).hooks[0]
    const output = await guard({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'mcp__graviton__theme_manager', tool_input: {}, tool_use_id: 't' }, 't', { signal: new AbortController().signal })
    expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
    await expect(options.canUseTool('mcp__graviton__theme_manager', {}, { signal: new AbortController().signal, toolUseID: 't' }))
      .resolves.toMatchObject({ behavior: 'deny' })
  })

  it('applies Graviton\'s Chat-mode policy to Graviton tools', async () => {
    const f = fixture({ operationMode: 'plan' })
    await f.service.run(f.input)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.cli.called.result.content[0].text).toContain('needs Agent mode')
    const guard = f.sdk.query.mock.calls[0][0].options.hooks.PreToolUse.at(-1).hooks[0]
    const verdict = (tool_name: string, tool_input: any = {}) => guard({ hook_event_name: 'PreToolUse', session_id: 's', tool_name, tool_input, tool_use_id: 't' }, 't', { signal: new AbortController().signal })
    expect((await verdict('mcp__graviton__theme_manager')).hookSpecificOutput?.permissionDecision).toBe('deny')
    // Chat mode allows Graviton's read-only tools.
    expect((await verdict('mcp__graviton__fetch_chats')).hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it('asks under Graviton\'s name, except for calls Graviton never asks about', async () => {
    const f = fixture({ autoApprove: false })
    // The run asks for theme_manager itself; answer it so the run can finish.
    const run = f.service.run(f.input)
    await vi.waitFor(() => expect(f.sdk.query).toHaveBeenCalled())
    const options = f.sdk.query.mock.calls[0][0].options
    const asked = options.canUseTool('mcp__graviton__theme_manager', { action: 'list' }, { signal: new AbortController().signal, toolUseID: 'ask' })
    await vi.waitFor(() => expect(f.broker.hasPending('stream', 'ask')).toBe(true))
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'permission_required', toolCallId: 'ask', toolName: 'theme_manager' }))
    f.broker.resolve('stream', 'ask', 'allow_once')
    await expect(asked).resolves.toMatchObject({ behavior: 'allow' })
    await expect(options.canUseTool('mcp__graviton__skill_manager', { action: 'search', query: 'x' }, { signal: new AbortController().signal, toolUseID: 'skill' }))
      .resolves.toMatchObject({ behavior: 'allow' })
    await expect(options.canUseTool('mcp__graviton__mcp_manager', { action: 'list' }, { signal: new AbortController().signal, toolUseID: 'mcp' }))
      .resolves.toMatchObject({ behavior: 'allow' })
    expect(f.broker.hasPending('stream', 'skill')).toBe(false)
    await run
  })

  it('tells a running Claude when Settings → Tools changes', async () => {
    const f = fixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    // Hold the run open after its tool call to toggle a tool mid-run.
    f.execute.mockImplementationOnce(async () => { await held; return { success: true, persistedContent: 'ok' } as any })
    const run = f.service.run(f.input)
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalled())
    const sent: any[] = []
    const transport = (f.cli.server as any).transport
    const original = transport.send.bind(transport)
    transport.send = async (message: any) => { sent.push(message); return original(message) }
    f.setStates({ fetch_chats: false })
    f.service.gravitonToolsChanged()
    expect(sent).toContainEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    release()
    await run
  })
})
