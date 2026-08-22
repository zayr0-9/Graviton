import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerMobileUiRoutes } from '../mobileUiRoutes.js'

describe('registerMobileUiRoutes', () => {
  let appServer: Server
  let baseUrl = ''

  beforeEach(() => {
    const app = express()
    registerMobileUiRoutes(app)

    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('serves /mobile index page', async () => {
    const res = await fetch(`${baseUrl}/mobile`)
    expect(res.status).toBe(200)
    const html = await res.text()

    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('/mobile/assets/mobile.css')
    expect(html).toContain('/mobile/assets/mobile-app.js')
  })

  it('serves mobile css asset', async () => {
    const res = await fetch(`${baseUrl}/mobile/assets/mobile.css`)
    expect(res.status).toBe(200)
    const css = await res.text()

    expect(css).toContain('.mobile-app-shell')
    expect(css).toContain('.mobile-tool-card')
    expect(css).toContain('.mobile-reasoning-card')
  })

  it('serves bundled mobile app javascript', async () => {
    const res = await fetch(`${baseUrl}/mobile/assets/mobile-app.js`)
    expect(res.status).toBe(200)
    const script = await res.text()

    expect(script).toContain('createRoot')
    expect(script).toContain('mobile-app-shell')
  })
})
