import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as customToolManager from '../../../tools/customToolManager.js'
import { toolOrchestrator } from '../../../tools/orchestrator/index.js'
import { registerCustomToolRpcRoutes } from '../customToolRpcRoutes.js'

describe('registerCustomToolRpcRoutes', () => {
  let appServer: Server
  let baseUrl = ''

  beforeEach(() => {
    const app = express()
    app.use(express.json())
    registerCustomToolRpcRoutes(app)

    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await new Promise<void>((resolve, reject) => {
      appServer.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('invokes custom tool via json-rpc', async () => {
    vi.spyOn(customToolManager, 'execute').mockResolvedValue({
      success: true,
      invokedToolName: 'demo_tool',
      value: { ok: true },
    } as any)

    const res = await fetch(`${baseUrl}/api/headless/custom-tools/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'customTool.invoke',
        params: {
          name: 'demo_tool',
          args: { ping: 'pong' },
        },
      }),
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.jsonrpc).toBe('2.0')
    expect(payload.id).toBe('req-1')
    expect(payload.result.success).toBe(true)
    expect(payload.result.invokedToolName).toBe('demo_tool')
  })

  it('reads files via orchestrator-backed read_file tool', async () => {
    vi.spyOn(toolOrchestrator, 'submit').mockReturnValue({ id: 'job-1' } as any)
    vi.spyOn(toolOrchestrator, 'getJob').mockReturnValue({
      id: 'job-1',
      status: 'completed',
      result: { success: true, content: 'hello world' },
    } as any)

    const res = await fetch(`${baseUrl}/api/headless/custom-tools/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'fs.readFile',
        params: {
          path: 'README.md',
          maxBytes: 1024,
        },
      }),
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.error).toBeUndefined()
    expect(payload.result.success).toBe(true)
    expect(payload.result.content).toBe('hello world')
  })

  it('returns json-rpc method-not-found for unknown methods', async () => {
    const res = await fetch(`${baseUrl}/api/headless/custom-tools/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'missing',
        method: 'does.not.exist',
      }),
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.error).toBeTruthy()
    expect(payload.error.code).toBe(-32601)
    expect(payload.error.message).toContain('Unsupported method')
  })
})
