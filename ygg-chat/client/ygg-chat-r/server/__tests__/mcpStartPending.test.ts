import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpManager } from '../mcp/mcpManager.js'
import { mcpOAuthSecretStore } from '../mcp/mcpOAuthSecrets.js'
import { MCP_START_PHASE_MESSAGE, settleWithin } from '../mcp/mcpStartPhase.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('settleWithin', () => {
  it('returns the value of an operation that finishes inside the budget', async () => {
    expect(await settleWithin(Promise.resolve('done'), 1000)).toEqual({ settled: true, value: 'done' })
  })

  it('propagates a failure inside the budget', async () => {
    await expect(settleWithin(Promise.reject(new Error('refused')), 1000)).rejects.toThrow('refused')
  })

  it('answers unsettled and absorbs the later failure of the operation it left running', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const operation = deferred<void>()
      expect(await settleWithin(operation.promise, 5)).toEqual({ settled: false })
      operation.reject(new Error('sign-in abandoned'))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('McpManager start phases', () => {
  const managers: McpManager[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.shutdown()))
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function configured() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygg-mcp-pending-'))
    tempDirs.push(dataDir)
    await fs.writeFile(path.join(dataDir, 'mcp-servers.json'), JSON.stringify({ servers: {
      remote: { enabled: true, transport: 'http', url: 'https://mcp.example.test/mcp', credentialStorage: 'vault' },
    } }))
    const manager = new McpManager()
    managers.push(manager)
    vi.spyOn(manager, 'getConfigDirectory').mockReturnValue(dataDir)
    await manager.initialize()
    return { manager, config: (await manager.getConfigs())[0]! }
  }

  const answerJsonRpc = () => vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method: string }
    const result = request.method === 'initialize' ? { serverInfo: { name: 'test' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
      : request.method === 'resources/list' ? { resources: [] }
      : request.method === 'prompts/list' ? { prompts: [] } : {}
    return new Response(request.id == null ? '' : JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
      { status: request.id == null ? 202 : 200, headers: { 'content-type': 'application/json' } })
  })

  it('reports a start parked on the keychain as connecting, shares it, then connects', async () => {
    const vault = deferred<Record<string, string>>()
    const load = vi.spyOn(mcpOAuthSecretStore, 'load').mockReturnValue(vault.promise as never)
    answerJsonRpc()
    const { manager, config } = await configured()
    expect(manager.getServerStatus('remote')).toBeUndefined()

    const first = manager.startServer(config)
    const second = manager.startServer(config)
    await vi.waitFor(() => expect(load).toHaveBeenCalled())

    // Nothing is connected and no client exists yet, but the wait is visible.
    expect(manager.getStartPhase('remote')).toBe('credentials')
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'connecting', phase: 'credentials', tools: [] })
    expect(manager.getStatus()).toEqual([expect.objectContaining({ name: 'remote', status: 'connecting', phase: 'credentials' })])
    // Repeat starts join the same attempt rather than prompting again.
    expect(await settleWithin(second, 5)).toEqual({ settled: false })
    expect(load).toHaveBeenCalledOnce()

    vault.resolve({})
    await Promise.all([first, second])
    expect(manager.getStartPhase('remote')).toBeUndefined()
    const connected = manager.getServerStatus('remote')
    expect(connected).toMatchObject({ status: 'connected' })
    expect(connected?.phase).toBeUndefined()
    expect(connected?.tools.map(tool => tool.name)).toEqual(['echo'])
  })

  it('keeps the reason when the keychain is denied, and clears it on stop', async () => {
    vi.spyOn(mcpOAuthSecretStore, 'load').mockRejectedValue(new Error('User denied keychain access'))
    const { manager, config } = await configured()
    await expect(manager.startServer(config)).rejects.toThrow('denied')
    expect(manager.getStartPhase('remote')).toBeUndefined()
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'error', error: 'User denied keychain access' })
    await manager.stopServer('remote')
    expect(manager.getServerStatus('remote')).toBeUndefined()
  })

  it('fences a stopped credential load so a new start cannot be overwritten', async () => {
    const vault = deferred<Record<string, string>>()
    vi.spyOn(mcpOAuthSecretStore, 'load').mockReturnValueOnce(vault.promise as never).mockResolvedValue({})
    answerJsonRpc()
    const { manager, config } = await configured()
    const old = manager.startServer(config).catch(error => error)
    await vi.waitFor(() => expect(manager.getStartPhase('remote')).toBe('credentials'))
    // Ensure the first operation actually entered load before stopping.
    await vi.waitFor(() => expect(mcpOAuthSecretStore.load).toHaveBeenCalledTimes(1))
    await manager.stopServer('remote')
    await manager.startServer(config)
    vault.resolve({ accessToken: 'obsolete' })
    expect(await old).toBeInstanceOf(Error)
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'connected' })
  })

  it('restarts a stopped server from its saved configuration', async () => {
    vi.spyOn(mcpOAuthSecretStore, 'load').mockResolvedValue({})
    answerJsonRpc()
    const { manager } = await configured()
    await manager.stopServer('remote')
    await manager.restartServer('remote')
    expect(manager.getServerStatus('remote')).toMatchObject({ status: 'connected' })
  })

  it('has a user-facing explanation for every phase', () => {
    expect(MCP_START_PHASE_MESSAGE.credentials).toMatch(/keychain/i)
    expect(MCP_START_PHASE_MESSAGE.authorizing).toMatch(/browser/i)
    expect(MCP_START_PHASE_MESSAGE.connecting).toBeTruthy()
  })
})
