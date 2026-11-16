import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerLegacyMobileRedirect } from '../legacyMobileRedirect.js'

describe('registerLegacyMobileRedirect', () => {
  let appServer: Server
  let baseUrl = ''

  beforeEach(() => {
    const app = express()
    registerLegacyMobileRedirect(app)
    appServer = app.listen(0)
    const address = appServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close(error => (error ? reject(error) : resolve()))
    })
  })

  it.each(['/mobile', '/mobile/', '/mobile/assets/mobile-app.js'])('redirects %s to the shared root UI', async path => {
    const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})
