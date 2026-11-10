import express, { type Express } from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'

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
  app.use(express.static(directory, {
    index: false,
    dotfiles: 'deny',
    redirect: false,
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-store' : 'public, max-age=3600')
      res.setHeader('X-Content-Type-Options', 'nosniff')
    },
  }))
}
