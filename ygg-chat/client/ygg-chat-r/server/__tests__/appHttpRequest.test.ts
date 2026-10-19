import { describe, expect, it } from 'vitest'
import { appHttpRequest, isPublicAppAddress } from '../routes/appHttpRequest.js'
describe('embedded app HTTP boundary', () => {
  it('rejects private, loopback, mapped, link-local and tunnel ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fd7a:115c:a1e0::1', '2002:7f00:1::', '2001:0:1234::']) expect(isPublicAppAddress(address), address).toBe(false)
    expect(isPublicAppAddress('8.8.8.8')).toBe(true)
    expect(isPublicAppAddress('2606:4700:4700::1111')).toBe(true)
  })
  it('never sends a request to the host or non-HTTP protocols', async () => {
    await expect(appHttpRequest({ url: 'http://127.0.0.1:3002/api/host/auth/logout', method: 'POST' })).rejects.toThrow('private')
    await expect(appHttpRequest({ url: 'file:///etc/passwd' })).rejects.toThrow('Invalid HTTP')
    await expect(appHttpRequest({ url: 'http://user:password@example.com/' })).rejects.toThrow('Invalid HTTP')
  })
})
