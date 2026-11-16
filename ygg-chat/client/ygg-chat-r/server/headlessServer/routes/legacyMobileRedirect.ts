import type { Express } from 'express'

/**
 * The legacy /mobile LAN UI was retired in favour of the shared React client
 * served at the host root. Old bookmarks and QR codes redirect there.
 */
export function registerLegacyMobileRedirect(app: Express): void {
  app.get(['/mobile', '/mobile/*'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.redirect(302, '/')
  })
}
