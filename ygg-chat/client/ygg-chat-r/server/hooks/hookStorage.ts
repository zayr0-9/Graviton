import { createRequire as createNodeRequire } from 'module'
import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'

const HOOKS_DIR_NAME = '.ygg'
const YGG_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

function isHookDebugLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.YGG_HOOK_DEBUG_LOGS || '')
}

function logHookStorage(message: string, details?: Record<string, unknown>): void {
  if (!isHookDebugLoggingEnabled()) return
  console.info(`[HookStorage] ${message}`, details || {})
}

let cachedHooksDir: string | null = null
let initializationPromise: Promise<string> | null = null
let hasInitializedManagedHooks = false

type ElectronAppLike = {
  getPath: (name: string) => string
  getAppPath: () => string
  isPackaged?: boolean
}

const electronRequire = createNodeRequire(import.meta.url)
let cachedElectronApp: ElectronAppLike | null | undefined

function getElectronApp(): ElectronAppLike | null {
  if (cachedElectronApp !== undefined) {
    return cachedElectronApp
  }

  try {
    const electronModule = electronRequire('electron') as any
    cachedElectronApp = (electronModule?.app as ElectronAppLike | undefined) || null
  } catch {
    cachedElectronApp = null
  }

  return cachedElectronApp
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsPromises.access(targetPath, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function readFileIfExists(targetPath: string): Promise<Buffer | null> {
  try {
    return await fsPromises.readFile(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

async function writeFileAtomically(targetPath: string, content: Buffer): Promise<void> {
  const targetDir = path.dirname(targetPath)
  await fsPromises.mkdir(targetDir, { recursive: true })

  const tempPath = path.join(
    targetDir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )

  try {
    await fsPromises.writeFile(tempPath, content)
    await fsPromises.rename(tempPath, targetPath)
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function syncBundledFile(sourcePath: string, targetPath: string): Promise<void> {
  const sourceContent = await fsPromises.readFile(sourcePath)
  const targetContent = await readFileIfExists(targetPath)
  if (targetContent && Buffer.compare(sourceContent, targetContent) === 0) {
    logHookStorage('bundled hook file already up to date', { sourcePath, targetPath })
    return
  }

  await writeFileAtomically(targetPath, sourceContent)
  logHookStorage('copied bundled hook file', { sourcePath, targetPath, bytes: sourceContent.byteLength })
}

async function syncBundledTree(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStats = await fsPromises.stat(sourcePath)

  if (sourceStats.isDirectory()) {
    await fsPromises.mkdir(targetPath, { recursive: true })
    const entries = await fsPromises.readdir(sourcePath, { withFileTypes: true })
    for (const entry of entries) {
      await syncBundledTree(path.join(sourcePath, entry.name), path.join(targetPath, entry.name))
    }
    return
  }

  await syncBundledFile(sourcePath, targetPath)
}

function resolveBundledHooksDirectory(): string {
  const envOverride = process.env.YGG_HOOKS_TEMPLATE_DIRECTORY?.trim()
  if (envOverride) {
    const resolved = path.resolve(envOverride)
    logHookStorage('resolved bundled hooks directory from env', { bundledHooksDir: resolved })
    return resolved
  }

  const electronApp = getElectronApp()
  if (electronApp?.isPackaged) {
    // resourcesPath is an Electron-only Process property; isPackaged proves the Electron host
    const { resourcesPath } = process as NodeJS.Process & { resourcesPath: string }
    const resolved = path.join(resourcesPath, HOOKS_DIR_NAME)
    logHookStorage('resolved packaged bundled hooks directory', { bundledHooksDir: resolved, resourcesPath })
    return resolved
  }

  try {
    if (electronApp) {
      const resolved = path.join(electronApp.getAppPath(), HOOKS_DIR_NAME)
      logHookStorage('resolved app bundled hooks directory', { bundledHooksDir: resolved, appPath: electronApp.getAppPath() })
      return resolved
    }
  } catch (error) {
    logHookStorage('failed to resolve app bundled hooks directory; falling back to cwd', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const resolved = path.resolve(process.cwd(), HOOKS_DIR_NAME)
  logHookStorage('resolved cwd bundled hooks directory', { bundledHooksDir: resolved })
  return resolved
}

export function getManagedHooksDirectory(): string {
  if (cachedHooksDir) {
    return cachedHooksDir
  }

  const envOverride = process.env.YGG_HOOKS_DIRECTORY?.trim()
  if (envOverride) {
    cachedHooksDir = path.resolve(envOverride)
    logHookStorage('resolved managed hooks directory from env', { managedHooksDir: cachedHooksDir })
    return cachedHooksDir
  }

  const electronApp = getElectronApp()
  if (electronApp) {
    cachedHooksDir = path.join(electronApp.getPath('userData'), HOOKS_DIR_NAME)
    logHookStorage('resolved managed hooks directory from electron userData', {
      managedHooksDir: cachedHooksDir,
      userData: electronApp.getPath('userData'),
    })
    return cachedHooksDir
  }

  cachedHooksDir = path.resolve(process.cwd(), HOOKS_DIR_NAME)
  logHookStorage('resolved managed hooks directory from cwd', { managedHooksDir: cachedHooksDir })
  return cachedHooksDir
}

export function getManagedHooksWorkingDirectory(): string {
  return path.dirname(getManagedHooksDirectory())
}

async function initializeManagedHooks(): Promise<string> {
  const managedHooksDir = getManagedHooksDirectory()
  await fsPromises.mkdir(managedHooksDir, { recursive: true })

  const bundledHooksDir = resolveBundledHooksDirectory()
  const normalizedManaged = path.resolve(managedHooksDir)
  const normalizedBundled = path.resolve(bundledHooksDir)
  logHookStorage('initializing managed hooks', {
    managedHooksDir,
    bundledHooksDir,
    normalizedManaged,
    normalizedBundled,
  })

  if (normalizedManaged === normalizedBundled) {
    logHookStorage('managed hooks directory is bundled hooks directory; skipping copy', { managedHooksDir })
    hasInitializedManagedHooks = true
    return managedHooksDir
  }

  if (!(await pathExists(bundledHooksDir))) {
    logHookStorage('bundled hooks directory not found; using managed directory as-is', { bundledHooksDir, managedHooksDir })
    hasInitializedManagedHooks = true
    return managedHooksDir
  }

  for (const fileName of YGG_SETTINGS_FILES) {
    const sourceFile = path.join(bundledHooksDir, fileName)
    const targetFile = path.join(managedHooksDir, fileName)
    if (await pathExists(sourceFile)) {
      await syncBundledTree(sourceFile, targetFile)
    }
  }

  const bundledHooksScriptsDir = path.join(bundledHooksDir, 'hooks')
  const targetHooksScriptsDir = path.join(managedHooksDir, 'hooks')
  if (await pathExists(bundledHooksScriptsDir)) {
    await syncBundledTree(bundledHooksScriptsDir, targetHooksScriptsDir)
  } else {
    logHookStorage('bundled hook scripts directory not found', { bundledHooksScriptsDir })
  }

  hasInitializedManagedHooks = true
  logHookStorage('managed hooks initialized', { managedHooksDir })
  return managedHooksDir
}

export async function ensureManagedHooksInitialized(): Promise<string> {
  if (hasInitializedManagedHooks) {
    return getManagedHooksDirectory()
  }

  if (!initializationPromise) {
    initializationPromise = initializeManagedHooks().finally(() => {
      initializationPromise = null
    })
  } else {
    logHookStorage('reusing in-flight managed hooks initialization')
  }

  return initializationPromise
}
