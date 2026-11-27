import type { NextFunction, Request, Response } from 'express'
import { gzip, gzipSync } from 'node:zlib'

/** Below this the gzip envelope and CPU cost more than the bytes they save. */
export const JSON_COMPRESSION_MIN_BYTES = 1024
/** Up to this size gzip runs inline (well under a millisecond); larger bodies use zlib's thread pool. */
const SYNC_GZIP_MAX_BYTES = 64 * 1024

export function acceptsGzip(req: Request): boolean {
  return Boolean(req.headers['accept-encoding']) && req.acceptsEncodings('gzip', 'identity') === 'gzip'
}

/**
 * Serialises `payload` once and gzips it when the client accepts gzip and the body is large
 * enough to matter. `res.send` still derives the ETag and answers a matching If-None-Match
 * with 304, so conditional requests work on the compressed representation too.
 */
export function sendCompressedJson(req: Request, res: Response, payload: unknown): void {
  const json = JSON.stringify(payload) ?? ''
  if (!res.get('Content-Type')) res.type('application/json')
  if (json.length < JSON_COMPRESSION_MIN_BYTES) { res.send(json); return }
  res.vary('Accept-Encoding')
  if (!acceptsGzip(req) || res.get('Content-Encoding')) { res.send(json); return }
  if (json.length <= SYNC_GZIP_MAX_BYTES) { res.set('Content-Encoding', 'gzip').send(gzipSync(json, { level: 1 })); return }
  gzip(json, { level: 1 }, (error, compressed) => {
    if (res.destroyed || res.headersSent) return
    if (error) { res.send(json); return }
    res.set('Content-Encoding', 'gzip').send(compressed)
  })
}

/**
 * Routes `res.json` through `sendCompressedJson` for every finite JSON response. SSE and
 * streamed responses never call `res.json`, so they are unaffected.
 */
export function jsonCompressionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const original = res.json.bind(res)
  res.json = function compressedJson(this: Response, ...args: unknown[]) {
    // The deprecated two-argument form (status, body) keeps Express's own handling.
    if (args.length !== 1) return (original as (...a: unknown[]) => Response)(...args)
    sendCompressedJson(req, res, args[0])
    return res
  } as Response['json']
  next()
}
