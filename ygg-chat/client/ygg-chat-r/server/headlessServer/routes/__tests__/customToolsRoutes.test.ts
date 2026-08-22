import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as customToolManager from '../../../tools/customToolManager.js'
import { registerCustomToolsRoutes } from '../customToolsRoutes.js'

describe('registerCustomToolsRoutes', () => {
  let appServer: Server
  let baseUrl = ''

  beforeEach(() => {
    const app = express()
    app.use(express.json())
    registerCustomToolsRoutes(app)

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

  it('lists custom tools', async () => {
    vi.spyOn(customToolManager, 'execute').mockResolvedValue({
      success: true,
      tools: [{ name: 'my_tool', description: 'Demo', enabled: true, loaded: true, directoryName: 'my-tool' }],
      totalCount: 1,
    } as any)

    const res = await fetch(`${baseUrl}/api/headless/custom-tools`)
    expect(res.status).toBe(200)

    const payload = (await res.json()) as any
    expect(payload.success).toBe(true)
    expect(payload.tools).toHaveLength(1)
    expect(payload.tools[0].name).toBe('my_tool')
  })

  it('updates tool enabled state', async () => {
    vi.spyOn(customToolManager, 'execute').mockResolvedValue({
      success: true,
      tool: { name: 'my_tool', enabled: false },
    } as any)

    const res = await fetch(`${baseUrl}/api/headless/custom-tools/my_tool`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(200)
    const payload = (await res.json()) as any
    expect(payload.success).toBe(true)
    expect(payload.tool.name).toBe('my_tool')
  })
})
