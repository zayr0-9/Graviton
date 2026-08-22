// server/routes/appStoreRoutes.ts
//
// App-store APIs (/api/app-store/*: community proxy, zip upload
// validation, install, uninstall) and /api/app/restart, extracted
// verbatim from localServer.ts setupServer(). Includes the zip
// staging/validation helper cluster used only by these routes.
// Restart requires the host restart capability; standalone returns 501.

import AdmZip from 'adm-zip'
import express, { type Express } from 'express'
import fs from 'fs'
import path from 'path'
import { customToolRegistry } from '../tools/customToolLoader.js'
import { validateAndResolvePath } from '../toolPathPolicy.js'
import { getServerTempDir, tryGetHostCapabilities } from '../serverHost.js'

function sanitizeZipEntryName(entryName: string): string {
  return entryName.replace(/\\/g, '/').replace(/^\/+/, '')
}

const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.bat', '.sh'])
const MAX_UPLOAD_ENTRIES = 5000
const MAX_UPLOAD_UNPACKED_BYTES = 500 * 1024 * 1024
const REMOTE_API_BASE = 'https://webdrasil-production.up.railway.app/api'
const DEFAULT_PRESERVE_RESOURCE_DIRS = ['resources', 'resource']

function buildRemoteApiUrl(pathname: string): string {
  if (pathname.startsWith('/')) {
    return `${REMOTE_API_BASE}${pathname}`
  }
  return `${REMOTE_API_BASE}/${pathname}`
}

function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name)
}

function validateToolDefinition(definition: any): string | null {
  if (!definition || typeof definition !== 'object') return 'definition.json must be an object.'
  if (typeof definition.name !== 'string' || !isValidToolName(definition.name)) {
    return 'definition.json must include a valid "name" (lowercase letters, numbers, underscores).'
  }
  if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
    return 'definition.json must include a non-empty "description".'
  }
  if (!definition.inputSchema || typeof definition.inputSchema !== 'object') {
    return 'definition.json must include an "inputSchema" object.'
  }
  if (definition.inputSchema.type !== 'object') {
    return 'definition.json "inputSchema.type" must be "object".'
  }
  if (!definition.inputSchema.properties || typeof definition.inputSchema.properties !== 'object') {
    return 'definition.json "inputSchema.properties" must be an object.'
  }
  if (definition.enabled !== undefined && typeof definition.enabled !== 'boolean') {
    return 'definition.json "enabled" must be a boolean if provided.'
  }
  return null
}

function validateDescription(description: any): string | null {
  if (!description || typeof description !== 'object') return 'description.json must be an object.'
  const title = typeof description.title === 'string' ? description.title.trim() : ''
  const name = typeof description.name === 'string' ? description.name.trim() : ''
  if (!title && !name) {
    return 'description.json must include a "title" or "name".'
  }
  if (description.gitLink !== undefined) {
    if (typeof description.gitLink !== 'string' || !description.gitLink.trim()) {
      return 'description.json "gitLink" must be a non-empty string when provided.'
    }
    try {
      const url = new URL(description.gitLink)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'description.json "gitLink" must be an http(s) URL.'
      }
    } catch {
      return 'description.json "gitLink" must be a valid URL.'
    }
  }
  return null
}

function detectZipStripPrefix(entries: { entryName: string }[]): string | null {
  const normalized = entries.map(entry => sanitizeZipEntryName(entry.entryName)).filter(Boolean)
  if (normalized.length === 0) return null
  const prefix = 'custom-tools/'
  if (normalized.every(name => name.startsWith(prefix))) {
    return prefix
  }
  return null
}

async function extractZipBufferToDirectory(
  zipBuffer: Buffer,
  destDir: string
): Promise<{ extracted: number; skipped: number; strippedPrefix?: string | null }> {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  const stripPrefix = detectZipStripPrefix(entries)
  const rootDir = path.resolve(destDir)
  let extracted = 0
  let skipped = 0

  for (const entry of entries) {
    let entryName = sanitizeZipEntryName(entry.entryName)
    if (stripPrefix && entryName.startsWith(stripPrefix)) {
      entryName = entryName.slice(stripPrefix.length)
    }
    if (!entryName || entryName === '.' || entryName === '..') {
      continue
    }

    const targetPath = path.resolve(rootDir, entryName)
    if (!targetPath.startsWith(rootDir + path.sep) && targetPath !== rootDir) {
      skipped += 1
      continue
    }

    if (entry.isDirectory) {
      await fs.promises.mkdir(targetPath, { recursive: true })
      continue
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.promises.writeFile(targetPath, entry.getData())
    extracted += 1
  }

  return { extracted, skipped, strippedPrefix: stripPrefix }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath)
    return true
  } catch {
    return false
  }
}

function detectZipToolDirectoryName(entries: { entryName: string }[], strippedPrefix?: string | null): string | null {
  const rootDirs = new Set<string>()

  for (const entry of entries) {
    let entryName = sanitizeZipEntryName(entry.entryName)
    if (strippedPrefix && entryName.startsWith(strippedPrefix)) {
      entryName = entryName.slice(strippedPrefix.length)
    }

    if (!entryName) continue

    const [root] = entryName.split('/')
    if (!root || root === '.' || root === '..' || root === '__MACOSX') {
      continue
    }

    rootDirs.add(root)
  }

  if (rootDirs.size !== 1) {
    return null
  }

  return Array.from(rootDirs)[0]
}

async function stageZipBufferForToolInstall(zipBuffer: Buffer): Promise<{
  tempDir: string
  stagedToolsRoot: string
  stagedToolDirName: string
  stagedToolPath: string
  extracted: number
  skipped: number
  strippedPrefix?: string | null
}> {
  const zip = new AdmZip(zipBuffer)
  const entries = zip.getEntries()
  const strippedPrefix = detectZipStripPrefix(entries)
  const stagedToolDirName = detectZipToolDirectoryName(entries, strippedPrefix)

  if (!stagedToolDirName) {
    throw new Error('Zip must contain exactly one top-level tool directory.')
  }

  const tempDir = await fs.promises.mkdtemp(path.join(getServerTempDir(), 'ygg-app-store-'))
  const stagedToolsRoot = path.join(tempDir, 'custom-tools')
  await fs.promises.mkdir(stagedToolsRoot, { recursive: true })

  const { extracted, skipped } = await extractZipBufferToDirectory(zipBuffer, stagedToolsRoot)
  const stagedToolPath = path.join(stagedToolsRoot, stagedToolDirName)

  const stagedExists = await pathExists(stagedToolPath)
  if (!stagedExists) {
    throw new Error('Installed package is missing the expected tool directory.')
  }

  return {
    tempDir,
    stagedToolsRoot,
    stagedToolDirName,
    stagedToolPath,
    extracted,
    skipped,
    strippedPrefix,
  }
}

async function deployToolUpdateWithPreservedResources(options: {
  stagedToolPath: string
  targetToolPath: string
  preserveDirs?: string[]
}): Promise<{ preservedResources: number }> {
  const preserveDirs = (options.preserveDirs || DEFAULT_PRESERVE_RESOURCE_DIRS).filter(Boolean)
  const targetParentDir = path.dirname(options.targetToolPath)
  const targetName = path.basename(options.targetToolPath)
  const rollbackPath = path.join(
    targetParentDir,
    `${targetName}.__rollback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  )

  await fs.promises.rename(options.targetToolPath, rollbackPath)

  try {
    await fs.promises.cp(options.stagedToolPath, options.targetToolPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    })

    let preservedResources = 0

    for (const dirName of preserveDirs) {
      const sourcePath = path.join(rollbackPath, dirName)
      if (!(await pathExists(sourcePath))) {
        continue
      }

      const restorePath = path.join(options.targetToolPath, dirName)
      await fs.promises.rm(restorePath, { recursive: true, force: true })
      await fs.promises.cp(sourcePath, restorePath, {
        recursive: true,
        force: true,
        errorOnExist: false,
      })
      preservedResources += 1
    }

    await fs.promises.rm(rollbackPath, { recursive: true, force: true })
    return { preservedResources }
  } catch (error) {
    await fs.promises.rm(options.targetToolPath, { recursive: true, force: true }).catch(() => undefined)
    await fs.promises.rename(rollbackPath, options.targetToolPath).catch(() => undefined)
    throw error
  }
}

export function registerAppStoreRoutes(app: Express): void {
  // ============================================================================
  // App Store API Endpoints
  // ============================================================================

  // GET /api/app-store/community - Proxy community app list from remote server
  app.get('/api/app-store/community', async (_req, res) => {
    try {
      const response = await fetch(buildRemoteApiUrl('/app-store/community'))
      const data = await response.json()
      res.status(response.status).json(data)
    } catch (error) {
      console.error('[LocalServer] Failed to fetch community apps:', error)
      res.status(500).json({ success: false, error: 'Failed to fetch community apps' })
    }
  })

  // POST /api/app-store/community/upload - Proxy community upload to remote server
  app.post(
    '/api/app-store/community/upload',
    express.raw({ type: 'application/zip', limit: '500mb' }),
    async (req, res) => {
      try {
        if (!req.body || (req.body as Buffer).length === 0) {
          res.status(400).json({ success: false, error: 'Zip payload is required.' })
          return
        }

        const authHeader = req.headers.authorization
        if (!authHeader) {
          res.status(401).json({ success: false, error: 'Authorization header is required.' })
          return
        }

        const zipBuffer = req.body instanceof Buffer ? req.body : Buffer.from(req.body)
        const filenameHeader = req.headers['x-app-store-filename']

        const response = await fetch(buildRemoteApiUrl('/app-store/community/upload'), {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/zip',
            ...(filenameHeader ? { 'x-app-store-filename': String(filenameHeader) } : {}),
          },
          body: zipBuffer,
        })

        const data = await response.json()
        res.status(response.status).json(data)
      } catch (error) {
        console.error('[LocalServer] Failed to upload community app:', error)
        res.status(500).json({ success: false, error: 'Failed to upload community app' })
      }
    }
  )

  // POST /api/app-store/validate-upload - Validate community app zip before upload
  app.post(
    '/api/app-store/validate-upload',
    express.raw({ type: 'application/zip', limit: '500mb' }),
    async (req, res) => {
      try {
        if (!req.body || (req.body as Buffer).length === 0) {
          res.status(400).json({ success: false, error: 'Zip payload is required.' })
          return
        }

        const zipBuffer = req.body instanceof Buffer ? req.body : Buffer.from(req.body)

        const zip = new AdmZip(zipBuffer)
        const entries = zip.getEntries()

        if (!entries || entries.length === 0) {
          res.status(400).json({ success: false, error: 'Zip file is empty.' })
          return
        }

        if (entries.length > MAX_UPLOAD_ENTRIES) {
          res.status(400).json({ success: false, error: 'Zip file contains too many entries.' })
          return
        }

        const stripPrefix = detectZipStripPrefix(entries)
        const topLevel = new Set<string>()
        let totalUnpacked = 0
        let containsExecutables = false
        let hasRootFile = false
        const normalizedEntries: Array<{ entry: any; name: string }> = []

        for (const entry of entries) {
          let entryName = sanitizeZipEntryName(entry.entryName)
          if (stripPrefix && entryName.startsWith(stripPrefix)) {
            entryName = entryName.slice(stripPrefix.length)
          }
          if (!entryName) continue
          const lowerName = entryName.toLowerCase()
          if (lowerName.startsWith('__macosx/')) {
            continue
          }
          if (lowerName.endsWith('.ds_store') || lowerName.endsWith('thumbs.db')) {
            continue
          }
          if (entryName.split('/').some(part => part === '..')) {
            res.status(400).json({ success: false, error: 'Zip contains invalid path traversal entries.' })
            return
          }

          const isDirectory = entry.isDirectory || entryName.endsWith('/')
          if (!entryName.includes('/') && !isDirectory) {
            hasRootFile = true
          }

          const parts = entryName.split('/')
          if (parts[0]) topLevel.add(parts[0])

          if (!isDirectory) {
            totalUnpacked += entry.header.size
            const ext = path.extname(entryName).toLowerCase()
            if (EXECUTABLE_EXTENSIONS.has(ext)) {
              containsExecutables = true
            }
          }

          normalizedEntries.push({ entry, name: entryName })
        }

        if (totalUnpacked > MAX_UPLOAD_UNPACKED_BYTES) {
          res.status(400).json({ success: false, error: 'Zip file is too large when extracted.' })
          return
        }

        if (topLevel.size !== 1 || hasRootFile) {
          res.status(400).json({
            success: false,
            error: 'Zip must contain a single top-level folder that holds your tool files.',
          })
          return
        }

        const toolDir = Array.from(topLevel)[0]
        if (!toolDir || toolDir === '.' || toolDir === '..') {
          res.status(400).json({ success: false, error: 'Invalid tool directory name in zip.' })
          return
        }

        const definitionPath = `${toolDir}/definition.json`
        const descriptionPath = `${toolDir}/description.json`
        const indexPath = `${toolDir}/index.js`

        const definitionEntry = normalizedEntries.find(item => item.name === definitionPath)
        const descriptionEntry = normalizedEntries.find(item => item.name === descriptionPath)
        const indexEntry = normalizedEntries.find(item => item.name === indexPath)

        if (!definitionEntry || !descriptionEntry) {
          res.status(400).json({
            success: false,
            error: 'Zip must include definition.json and description.json in the tool folder root.',
          })
          return
        }

        if (!indexEntry) {
          res.status(400).json({ success: false, error: 'Zip must include index.js in the tool folder root.' })
          return
        }

        const extraDefinition = normalizedEntries.find(
          item => item.name.endsWith('/definition.json') && item.name !== definitionPath
        )
        if (extraDefinition) {
          res.status(400).json({ success: false, error: 'Zip must include only one definition.json file.' })
          return
        }

        const extraDescription = normalizedEntries.find(
          item => item.name.endsWith('/description.json') && item.name !== descriptionPath
        )
        if (extraDescription) {
          res.status(400).json({ success: false, error: 'Zip must include only one description.json file.' })
          return
        }

        const definitionRaw = definitionEntry.entry.getData().toString('utf-8')
        const descriptionRaw = descriptionEntry.entry.getData().toString('utf-8')

        let definitionJson: any
        let descriptionJson: any

        try {
          definitionJson = JSON.parse(definitionRaw)
        } catch {
          res.status(400).json({ success: false, error: 'definition.json must be valid JSON.' })
          return
        }

        try {
          descriptionJson = JSON.parse(descriptionRaw)
        } catch {
          res.status(400).json({ success: false, error: 'description.json must be valid JSON.' })
          return
        }

        const definitionError = validateToolDefinition(definitionJson)
        if (definitionError) {
          res.status(400).json({ success: false, error: definitionError })
          return
        }

        const descriptionError = validateDescription(descriptionJson)
        if (descriptionError) {
          res.status(400).json({ success: false, error: descriptionError })
          return
        }

        const warnings: string[] = []
        if (definitionJson.name !== toolDir && definitionJson.name !== toolDir.replace(/-/g, '_')) {
          warnings.push('Tool folder name does not match definition.json name.')
        }

        res.json({
          success: true,
          appId: definitionJson.name,
          toolDir,
          description: descriptionJson,
          definition: definitionJson,
          containsExecutables,
          warnings,
        })
      } catch (error) {
        console.error('[LocalServer] App store upload validation error:', error)
        const msg = error instanceof Error ? error.message : String(error)
        res.status(500).json({ success: false, error: msg })
      }
    }
  )

  // POST /api/app-store/install - Download and install/update an app package into custom tools
  app.post('/api/app-store/install', async (req, res) => {
    let tempDirToCleanup: string | null = null

    try {
      const { zipUrl, appId, appName, mode } = req.body || {}
      const requestedMode = mode === 'update' ? 'update' : 'install'

      if (!zipUrl || typeof zipUrl !== 'string') {
        res.status(400).json({ success: false, error: 'zipUrl is required' })
        return
      }

      const response = await fetch(zipUrl)
      if (!response.ok) {
        res.status(400).json({
          success: false,
          error: `Failed to download app package (${response.status} ${response.statusText})`,
        })
        return
      }

      const arrayBuffer = await response.arrayBuffer()
      const zipBuffer = Buffer.from(arrayBuffer)
      const customToolsDir = customToolRegistry.getCustomToolsDirectoryPath()

      await fs.promises.mkdir(customToolsDir, { recursive: true })

      let extracted = 0
      let skipped = 0
      let strippedPrefix: string | null | undefined = null
      let preservedResources = 0
      let effectiveMode: 'install' | 'update' = requestedMode

      if (requestedMode === 'update') {
        if (!appId || typeof appId !== 'string') {
          res.status(400).json({ success: false, error: 'appId is required for update mode' })
          return
        }

        if (appId.includes('/') || appId.includes('\\')) {
          res.status(400).json({ success: false, error: 'Invalid appId' })
          return
        }

        const staged = await stageZipBufferForToolInstall(zipBuffer)
        tempDirToCleanup = staged.tempDir
        extracted = staged.extracted
        skipped = staged.skipped
        strippedPrefix = staged.strippedPrefix

        const targetToolPath = validateAndResolvePath(appId, customToolsDir, false)
        const targetStats = await fs.promises.stat(targetToolPath).catch(() => null)
        if (!targetStats || !targetStats.isDirectory()) {
          res.status(404).json({ success: false, error: `Installed app directory not found for "${appId}"` })
          return
        }

        const deployed = await deployToolUpdateWithPreservedResources({
          stagedToolPath: staged.stagedToolPath,
          targetToolPath,
          preserveDirs: DEFAULT_PRESERVE_RESOURCE_DIRS,
        })
        preservedResources = deployed.preservedResources
      } else {
        const staged = await stageZipBufferForToolInstall(zipBuffer)
        tempDirToCleanup = staged.tempDir
        extracted = staged.extracted
        skipped = staged.skipped
        strippedPrefix = staged.strippedPrefix

        const targetToolPath = validateAndResolvePath(staged.stagedToolDirName, customToolsDir, false)
        const targetExists = await pathExists(targetToolPath)

        if (targetExists) {
          effectiveMode = 'update'
          const targetStats = await fs.promises.stat(targetToolPath)
          if (!targetStats.isDirectory()) {
            res.status(400).json({ success: false, error: 'Existing app path is not a directory' })
            return
          }

          const deployed = await deployToolUpdateWithPreservedResources({
            stagedToolPath: staged.stagedToolPath,
            targetToolPath,
            preserveDirs: DEFAULT_PRESERVE_RESOURCE_DIRS,
          })
          preservedResources = deployed.preservedResources
        } else {
          await fs.promises.cp(staged.stagedToolPath, targetToolPath, {
            recursive: true,
            force: true,
            errorOnExist: false,
          })
        }
      }

      await customToolRegistry.reload(`app_store_${effectiveMode}`)
      const definitions = customToolRegistry.getDefinitions()

      res.json({
        success: true,
        appId,
        appName,
        mode: effectiveMode,
        extracted,
        skipped,
        strippedPrefix,
        preservedResources,
        toolCount: definitions.length,
        restartRequired: false,
        message:
          effectiveMode === 'update'
            ? `App updated and loaded. Preserved ${preservedResources} resource folder${preservedResources === 1 ? '' : 's'}.`
            : 'App installed and loaded.',
      })
    } catch (error) {
      console.error('[LocalServer] App store install error:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    } finally {
      if (tempDirToCleanup) {
        await fs.promises.rm(tempDirToCleanup, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  })

  // POST /api/app-store/uninstall - Remove an app package from custom tools
  app.post('/api/app-store/uninstall', async (req, res) => {
    try {
      const { appId } = req.body || {}

      if (!appId || typeof appId !== 'string') {
        res.status(400).json({ success: false, error: 'appId is required' })
        return
      }

      if (appId.includes('/') || appId.includes('\\')) {
        res.status(400).json({ success: false, error: 'Invalid appId' })
        return
      }

      const customToolsDir = customToolRegistry.getCustomToolsDirectoryPath()
      const targetPath = validateAndResolvePath(appId, customToolsDir, false)

      let stats: fs.Stats | null = null
      try {
        stats = await fs.promises.stat(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ success: false, error: 'App not installed' })
          return
        }
        throw error
      }

      if (!stats?.isDirectory()) {
        res.status(400).json({ success: false, error: 'App path is not a directory' })
        return
      }

      await fs.promises.rm(targetPath, { recursive: true, force: true })

      await customToolRegistry.reload('app_store_uninstall')
      const definitions = customToolRegistry.getDefinitions()

      res.json({
        success: true,
        appId,
        toolCount: definitions.length,
        restartRequired: false,
        message: 'App uninstalled.',
      })
    } catch (error) {
      console.error('[LocalServer] App store uninstall error:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })

  // POST /api/app/restart - Relaunch the host application. Only hosts that
  // supply the restart capability support this; standalone returns 501.
  app.post('/api/app/restart', (_req, res) => {
    try {
      const restart = tryGetHostCapabilities()?.restart
      if (!restart) {
        res.status(501).json({ success: false, error: 'Restart is not supported by this host' })
        return
      }
      res.json({ success: true, message: 'Restarting app' })
      setTimeout(() => {
        restart().catch(error => {
          console.error('[LocalServer] Failed to restart app:', error)
        })
      }, 300)
    } catch (error) {
      console.error('[LocalServer] Restart request failed:', error)
      const msg = error instanceof Error ? error.message : String(error)
      res.status(500).json({ success: false, error: msg })
    }
  })
}
