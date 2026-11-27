import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { acceptsGzip } from '../responseCompression.js'

const gzipAsync = promisify(gzip)
/** Text assets worth compressing; images and fonts are already compressed. */
const COMPRESSIBLE = /\.(?:js|mjs|css|svg|json|html|txt|xml|map|wasm)$/i
/** Vite names bundles `/assets/<name>-<8-char hash>.<ext>`; those never change under one URL. */
const HASHED_ASSET = /[/\\]assets[/\\][^/\\]+-[\w-]{8}\.\w+$/
/** Compressed bodies stay in memory up to this total, then the cache starts over. */
const COMPRESSED_CACHE_MAX_BYTES = 64 * 1024 * 1024

function cacheControlFor(file: string): string {
  if (file.endsWith('.html')) return 'no-store'
  return HASHED_ASSET.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
}

/**
 * Serves compressible files from the built tree gzipped (level 6, cached per file version),
 * with the same cache policy as the plain static handler. Anything it cannot serve falls
 * through to `express.static`, which also answers clients that do not accept gzip.
 */
function compressedStatic(directory: string) {
  const cache = new Map<string, { version: string; body: Buffer }>()
  let cachedBytes = 0
  return async (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !COMPRESSIBLE.test(req.path) || !acceptsGzip(req)) { next(); return }
    let file: string
    try { file = path.join(directory, path.normalize(decodeURIComponent(req.path))) } catch { next(); return }
    if (!file.startsWith(directory + path.sep) || path.relative(directory, file).split(path.sep).some(segment => segment.startsWith('.'))) { next(); return }
    try {
      const info = await stat(file)
      if (!info.isFile()) { next(); return }
      const version = `${info.size}:${info.mtimeMs}`
      let entry = cache.get(file)
      if (entry?.version !== version) {
        entry = { version, body: await gzipAsync(await readFile(file), { level: 6 }) }
        if (cachedBytes + entry.body.length > COMPRESSED_CACHE_MAX_BYTES) { cache.clear(); cachedBytes = 0 }
        cache.set(file, entry)
        cachedBytes += entry.body.length
      }
      res.type(path.extname(file))
      const type = res.get('Content-Type')
      if (type && !/charset/i.test(type) && /^(?:text\/|application\/(?:javascript|json|xml))/.test(type)) res.setHeader('Content-Type', `${type}; charset=utf-8`)
      res.setHeader('Content-Encoding', 'gzip')
      res.vary('Accept-Encoding')
      res.setHeader('Cache-Control', cacheControlFor(file))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.send(entry.body)
    } catch { next() }
  }
}

/** Only the built public tree is exposed. No SPA fallback for missing assets/APIs. */
export function registerBrowserUiRoutes(app: Express, root?: string): void {
  if (!root) return
  const directory = path.resolve(root)
  const index = path.join(directory, 'index.html')
  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!existsSync(index)) {
      res.status(503).type('text/plain').send('Browser client is not built. Run npm run build:browser-client on the host.')
      return
    }
    res.sendFile(index)
  })
  app.use(compressedStatic(directory))
  app.use(express.static(directory, {
    index: false,
    dotfiles: 'deny',
    redirect: false,
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', cacheControlFor(file))
      res.setHeader('X-Content-Type-Options', 'nosniff')
    },
  }))
}
