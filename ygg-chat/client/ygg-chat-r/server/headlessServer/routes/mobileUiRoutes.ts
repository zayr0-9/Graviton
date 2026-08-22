import type { Express } from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const resolveMobileUiRootDir = (): string => {
  const candidateDirs: string[] = []

  try {
    candidateDirs.push(fileURLToPath(new URL('../ui/mobile', import.meta.url)))
  } catch {
    // ignore and continue fallback resolution
  }

  const bundleDirFromRuntime = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
  // dist-server layout: assets copied next to ygg-server.mjs
  candidateDirs.push(path.resolve(bundleDirFromRuntime, 'headlessServer', 'ui', 'mobile'))
  // packaged Electron layout: bundle at electron/main.mjs, assets under server/
  candidateDirs.push(path.resolve(bundleDirFromRuntime, '..', 'server', 'headlessServer', 'ui', 'mobile'))

  candidateDirs.push(
    path.resolve(process.cwd(), 'server', 'headlessServer', 'ui', 'mobile'),
    path.resolve(process.cwd(), 'headlessServer', 'ui', 'mobile'),
    path.resolve(process.cwd(), 'ui', 'mobile')
  )

  for (const candidateDir of candidateDirs) {
    if (existsSync(path.join(candidateDir, 'index.html'))) {
      return candidateDir
    }
  }

  throw new Error(`Unable to locate mobile UI root directory. Checked: ${candidateDirs.join(', ')}`)
}

const MOBILE_UI_ROOT = resolveMobileUiRootDir()
const MOBILE_UI_INDEX = path.join(MOBILE_UI_ROOT, 'index.html')
const MOBILE_UI_ASSETS = path.join(MOBILE_UI_ROOT, 'assets')

export function registerMobileUiRoutes(app: Express): void {
  app.get('/mobile', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(MOBILE_UI_INDEX)
  })

  app.get('/mobile/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(MOBILE_UI_INDEX)
  })

  app.get('/mobile/assets/*', (req, res) => {
    // @types/express is ^5 while express is ^4.21.2. Express 4 exposes an unnamed
    // wildcard capture as req.params[0]; the v5 types model it as { "": string[] }.
    // Read through a v4-shaped view until the types match the runtime version.
    const wildcardParams = req.params as unknown as Record<string, string | undefined>
    const requestedPath = String(wildcardParams[0] || '').trim()
    if (!requestedPath) {
      res.status(404).json({ success: false, error: 'Asset not found' })
      return
    }

    const normalizedPath = path.normalize(requestedPath)
    const absoluteAssetsRoot = path.resolve(MOBILE_UI_ASSETS)
    const absoluteAssetPath = path.resolve(absoluteAssetsRoot, normalizedPath)

    if (!absoluteAssetPath.startsWith(absoluteAssetsRoot + path.sep) && absoluteAssetPath !== absoluteAssetsRoot) {
      res.status(400).json({ success: false, error: 'Invalid asset path' })
      return
    }

    if (!existsSync(absoluteAssetPath)) {
      res.status(404).json({ success: false, error: 'Asset not found' })
      return
    }

    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(absoluteAssetPath)
  })
}
