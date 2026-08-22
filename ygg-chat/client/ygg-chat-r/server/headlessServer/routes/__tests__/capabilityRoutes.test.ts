import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customToolRegistry } from '../../../tools/customToolLoader.js'
import { registerCapabilityRoutes } from '../capabilityRoutes.js'

describe('registerCapabilityRoutes', () => {
  let appServer: Server
  let baseUrl = ''

  beforeEach(() => {
    const app = express()
    registerCapabilityRoutes(app, {
      getDefaultTools: () => [
        { name: 'read_file', description: 'Read file' },
        { name: 'edit_file', description: 'Edit file' },
      ],
    })

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

  it('serves capabilities in both compatibility and v1 paths', async () => {
    const [legacyRes, v1Res] = await Promise.all([
      fetch(`${baseUrl}/api/headless/capabilities`),
      fetch(`${baseUrl}/api/v1/capabilities`),
    ])

    expect(legacyRes.status).toBe(200)
    expect(v1Res.status).toBe(200)

    const legacyPayload = (await legacyRes.json()) as any
    const v1Payload = (await v1Res.json()) as any

    expect(legacyPayload.apiVersion).toBe('v1')
    expect(v1Payload.apiVersion).toBe('v1')
    expect(legacyPayload.chat.operations).toContain('send')
    expect(v1Payload.tools.map((tool: any) => tool.name)).toContain('read_file')
  })

  it('omits custom tool definitions when includeCustomTools=false', async () => {
    vi.spyOn(customToolRegistry, 'getDefinitions').mockReturnValue([
      { name: 'my_custom_tool', description: 'Custom', enabled: true } as any,
    ])

    const app = express()
    registerCapabilityRoutes(app, {
      getDefaultTools: () => [
        { name: 'read_file', description: 'Read file' },
        { name: 'my_custom_tool', description: 'Custom tool' },
      ],
    })

    const server = app.listen(0)
    const address = server.address() as AddressInfo
    const scopedBaseUrl = `http://127.0.0.1:${address.port}`

    const res = await fetch(`${scopedBaseUrl}/api/headless/capabilities?includeCustomTools=false`)
    const payload = (await res.json()) as any

    expect(res.status).toBe(200)
    expect(payload.tools.map((tool: any) => tool.name)).toEqual(['read_file'])

    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  })
})
