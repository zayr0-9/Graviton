import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import { ClaudeMcpControlService, ClaudeMcpControlError } from '../claudeMcpControl.js'
import { claudeMcpLaunchOptions, claudeMcpToolServerName, validateHostClaudeMcpPreferences, DEFAULT_HOST_CLAUDE_MCP } from '../../../../../../shared/claudeNativeMcp.js'
import { normalizeHostExecutionPreferences } from '../../../../../../shared/hostExecutionPreferences.js'

type Server = { name: string; status: string; source?: string; config?: any; error?: string; tools?: Array<{ name: string }> }

function control(servers: Server[] | (() => Server[]), extra: Record<string, any> = {}, preferences = { ...DEFAULT_HOST_CLAUDE_MCP, enabled: true }) {
  const list = typeof servers === 'function' ? servers : () => servers
  const queries: any[] = []
  const sdk = { query: vi.fn((params: any) => {
    const query = { params, close: vi.fn(), mcpServerStatus: vi.fn(async () => list()), reconnectMcpServer: vi.fn(async () => {}), ...extra }
    queries.push(query)
    return query
  }) }
  const service = new ClaudeMcpControlService({ preferences: () => preferences, sdk: async () => sdk as any, executable: async () => '/mock/claude',
    settleMs: 50, pollMs: 5, signInTtlMs: 1_000 })
  return { service, sdk, queries }
}

afterEach(() => { vi.useRealTimers() })

describe('shared Claude MCP settings', () => {
  it('normalizes server names the way the CLI does', () => {
    expect(claudeMcpToolServerName('claude.ai Vega GP (UAT env)')).toBe('claude_ai_Vega_GP_UAT_env')
    expect(claudeMcpToolServerName('claude.ai Atlassian (2)')).toBe('claude_ai_Atlassian_2')
    expect(claudeMcpToolServerName('plugin:slack:slack')).toBe('plugin_slack_slack')
    // Only claude.ai connectors collapse repeats; other names keep one `_` per character.
    expect(claudeMcpToolServerName('my server (dev)')).toBe('my_server__dev_')
    expect(claudeMcpToolServerName('supabase')).toBe('supabase')
  })

  it('validates the host domain and defaults it off', () => {
    expect(normalizeHostExecutionPreferences({}).claudeMcp).toEqual({ enabled: false, claudeAiConnectors: true, disabledServers: [] })
    expect(validateHostClaudeMcpPreferences({ enabled: true, disabledServers: ['a', 'a', 'b'] })).toEqual({ enabled: true, claudeAiConnectors: true, disabledServers: ['a', 'b'] })
    for (const bad of [null, [], { enabled: 'yes' }, { other: true }, { disabledServers: 'a' }, { disabledServers: [''] }, { disabledServers: ['a\nb'] }]) {
      expect(() => validateHostClaudeMcpPreferences(bad)).toThrow()
    }
  })

  it('maps settings to launch options', () => {
    expect(claudeMcpLaunchOptions(null)).toEqual({ strictMcpConfig: true, mcpServers: {} })
    expect(claudeMcpLaunchOptions({ enabled: true, claudeAiConnectors: true, disabledServers: [] })).toEqual({ strictMcpConfig: false })
    expect(claudeMcpLaunchOptions({ enabled: true, claudeAiConnectors: false, disabledServers: ['z', 'a', 'z'] }))
      .toEqual({ strictMcpConfig: false, disallowedTools: ['mcp__a', 'mcp__z'], settings: { disableClaudeAiConnectors: true } })
  })
})

describe('ClaudeMcpControlService', () => {
  it('lists servers without their config and marks hidden ones', async () => {
    const { service, queries } = control([
      { name: 'linear', status: 'connected', source: 'user', config: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer secret' } }, tools: [{ name: 'create_issue' }] },
      { name: 'local', status: 'failed', source: 'project', config: { command: 'node', env: { KEY: 'secret' } }, error: 'x'.repeat(900) },
      { name: 'graviton-test', status: 'connected', source: 'sdk' },
    ], {}, { enabled: true, claudeAiConnectors: false, disabledServers: ['local'] })
    const status = await service.status()
    expect(status.cwd).toBe(os.homedir())
    expect(status.signInAvailable).toBe(false)
    expect(status.servers.map(server => server.name)).toEqual(['linear', 'local'])
    expect(status.servers[0]).toEqual({ name: 'linear', status: 'connected', source: 'user', transport: 'http', error: null, tools: ['create_issue'], hidden: false })
    expect(status.servers[1]).toMatchObject({ transport: 'stdio', hidden: true })
    expect(status.servers[1].error!.length).toBeLessThan(520)
    expect(JSON.stringify(status)).not.toContain('secret')
    const options = queries[0].params.options
    expect(options).toMatchObject({ strictMcpConfig: false, persistSession: false, pathToClaudeCodeExecutable: '/mock/claude',
      settings: { disableAllHooks: true, disableClaudeAiConnectors: true } })
    expect(queries[0].close).toHaveBeenCalled()
  })

  it('waits for pending servers to settle', async () => {
    let calls = 0
    const { service } = control(() => [{ name: 'slow', status: ++calls < 3 ? 'pending' : 'connected' }])
    expect((await service.status()).servers[0].status).toBe('connected')
  })

  it('shares one CLI between concurrent status requests for a folder', async () => {
    const { service, sdk } = control([{ name: 'a', status: 'connected' }])
    await Promise.all([service.status(), service.status()])
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it('rejects a relative or missing workspace folder', async () => {
    const { service } = control([])
    await expect(service.status('relative/path')).rejects.toMatchObject({ status: 400 })
    await expect(service.status('/definitely/not/here/graviton')).rejects.toMatchObject({ status: 400 })
  })

  it('reports a missing CLI as unavailable', async () => {
    const service = new ClaudeMcpControlService({ preferences: () => DEFAULT_HOST_CLAUDE_MCP, sdk: async () => ({ query: vi.fn() }) as any,
      executable: async () => { throw new Error('Claude Code CLI is not installed on the host.') } })
    await expect(service.status()).rejects.toMatchObject({ status: 503, code: 'claude_cli_missing' })
  })

  it('signs in through Claude, keeps the CLI open until the server connects, then closes it', async () => {
    let connected = false
    const mcpAuthenticate = vi.fn(async () => ({ authUrl: 'https://auth.example/start', requiresUserAction: true, callbackExpected: true }))
    const { service, queries } = control(() => [{ name: 'remote', status: connected ? 'connected' : 'needs-auth' }], { mcpAuthenticate, mcpSubmitOAuthCallbackUrl: vi.fn(async () => ({})) })
    await expect(service.signIn('remote')).resolves.toEqual({ authUrl: 'https://auth.example/start', callbackExpected: true })
    expect(mcpAuthenticate).toHaveBeenCalledWith('remote')
    expect(service.signingIn('remote')).toBe(true)
    expect(queries[0].close).not.toHaveBeenCalled()
    await service.submitCallback('remote', 'http://localhost:1234/callback?code=abc')
    expect(queries[0].mcpSubmitOAuthCallbackUrl).toHaveBeenCalledWith('remote', 'http://localhost:1234/callback?code=abc')
    // A callback-based sign-in waits for Claude's own listener; it does not force reconnects.
    connected = true
    await vi.waitFor(() => expect(service.signingIn('remote')).toBe(false))
    expect(queries[0].close).toHaveBeenCalled()
    expect(queries[0].reconnectMcpServer).not.toHaveBeenCalled()
  })

  it('reconnects a claude.ai connector while its sign-in waits, since Claude cannot hear claude.ai', async () => {
    let connected = false
    const { service, queries } = control(() => [{ name: 'claude.ai Linear', status: connected ? 'connected' : 'needs-auth', source: 'claudeai' }],
      { mcpAuthenticate: vi.fn(async () => ({ authUrl: 'https://claude.ai/api/organizations/o/mcp/start-auth/s', callbackExpected: false })) })
    await expect(service.signIn('claude.ai Linear')).resolves.toMatchObject({ callbackExpected: false })
    await vi.waitFor(() => expect(queries[0].reconnectMcpServer).toHaveBeenCalledWith('claude.ai Linear'))
    connected = true
    await vi.waitFor(() => expect(service.signingIn('claude.ai Linear')).toBe(false))
  })

  it('gives up a sign-in after its lifetime and closes the CLI', async () => {
    const { service, queries } = control([{ name: 'remote', status: 'needs-auth' }], { mcpAuthenticate: vi.fn(async () => ({ authUrl: 'https://auth.example', callbackExpected: true })) })
    ;(service as any).deps.signInTtlMs = 30
    await service.signIn('remote')
    await vi.waitFor(() => expect(service.signingIn('remote')).toBe(false))
    expect(queries[0].close).toHaveBeenCalled()
    await expect(service.submitCallback('remote', 'http://localhost/cb')).rejects.toMatchObject({ status: 409 })
  })

  it('refuses a sign-in it cannot do safely', async () => {
    const none = control([{ name: 'remote', status: 'needs-auth' }])
    await expect(none.service.signIn('remote')).rejects.toMatchObject({ status: 501, code: 'claude_mcp_sign_in_unavailable' })
    expect(none.queries[0].close).toHaveBeenCalled()
    const missing = control([], { mcpAuthenticate: vi.fn() })
    await expect(missing.service.signIn('ghost')).rejects.toMatchObject({ status: 404 })
    const unsafe = control([{ name: 'remote', status: 'needs-auth' }], { mcpAuthenticate: vi.fn(async () => ({ authUrl: 'file:///etc/passwd' })) })
    await expect(unsafe.service.signIn('remote')).rejects.toBeInstanceOf(ClaudeMcpControlError)
    expect(unsafe.service.signingIn('remote')).toBe(false)
    await expect(unsafe.service.signIn('')).rejects.toMatchObject({ status: 400 })
  })

  it('replaces a waiting sign-in for the same server', async () => {
    const { service, queries } = control([{ name: 'remote', status: 'needs-auth' }], { mcpAuthenticate: vi.fn(async () => ({ authUrl: 'https://auth.example', callbackExpected: true })) })
    await service.signIn('remote')
    await service.signIn('remote')
    expect(queries[0].close).toHaveBeenCalled()
    expect(queries[1].close).not.toHaveBeenCalled()
    service.dispose()
    expect(queries[1].close).toHaveBeenCalled()
  })

  it('reconnects and reports the result, including a failure message', async () => {
    const { service } = control([{ name: 'remote', status: 'failed' }], { reconnectMcpServer: vi.fn(async () => { throw new Error('ECONNREFUSED') }) })
    await expect(service.reconnect('remote')).resolves.toMatchObject({ name: 'remote', status: 'failed', error: 'ECONNREFUSED' })
  })

  it('signs out through Claude', async () => {
    const mcpClearAuth = vi.fn(async () => ({}))
    const { service, queries } = control([{ name: 'remote', status: 'connected' }], { mcpClearAuth })
    await service.signOut('remote')
    expect(mcpClearAuth).toHaveBeenCalledWith('remote')
    expect(queries[0].close).toHaveBeenCalled()
  })
})
