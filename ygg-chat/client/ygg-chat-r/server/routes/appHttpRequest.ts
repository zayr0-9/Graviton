import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export function isPublicAppAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19))
  }
  if (isIP(address) === 6) {
    // Only global unicast; reject mapped IPv4, loopback, ULA and link-local.
    return /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith('2001:db8:') && !address.toLowerCase().startsWith('2002:') && !/^2001:0{1,4}:/i.test(address)
  }
  return false
}

/** Public destinations only, pinned DNS lookup, no redirects/ambient credentials.
 * This is an embedded-app boundary, not access authentication for network peers. */
export async function appHttpRequest(params: Record<string, any>): Promise<any> {
  const url = new URL(params.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid HTTP URL')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(value => !isPublicAppAddress(value.address))) throw new Error('Embedded apps cannot request private, loopback or host services')
  const address = addresses[0]
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : 'GET'
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new Error('Invalid HTTP method')
  const headers: Record<string, string> = {}
  const blocked = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'connection', 'transfer-encoding', 'content-length', 'origin', 'referer'])
  if (params.headers && typeof params.headers === 'object') for (const [name, value] of Object.entries(params.headers)) {
    if (!blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith('sec-') && typeof value === 'string') headers[name] = value
  }
  const body = ['GET', 'HEAD'].includes(method) ? undefined : typeof params.body === 'string' ? params.body : params.body === undefined ? undefined : JSON.stringify(params.body)
  if (body && Buffer.byteLength(body) > 5 * 1024 * 1024) throw new Error('App HTTP request exceeds capacity')
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, headers,
      lookup: (_hostname: string, options: any, callback: any) => options?.all ? callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family),
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 5 * 1024 * 1024) { request.destroy(new Error('App HTTP response exceeds capacity')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data: any = text
        if (String(response.headers['content-type']).includes('application/json')) { try { data = JSON.parse(text) } catch {} }
        resolve({ success: true, status: response.statusCode, ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300, headers: response.headers, data })
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('App HTTP request timed out')), 30000)
    request.once('close', () => clearTimeout(timer))
    request.once('error', reject)
    request.end(body)
  })
}
