import { createRequire as createNodeRequire } from 'module'
import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'

const HOOKS_DIR_NAME = '.ygg'
const YGG_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

let cachedHooksDir: string | null = null

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

  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true })
  await fsPromises.copyFile(sourcePath, targetPath)
}

function resolveBundledHooksDirectory(): string {
  const envOverride = process.env.YGG_HOOKS_TEMPLATE_DIRECTORY?.trim()
  if (envOverride) {
    return path.resolve(envOverride)
  }

  const electronApp = getElectronApp()
  if (electronApp?.isPackaged) {
    return path.join(process.resourcesPath, HOOKS_DIR_NAME)
  }

  try {
    if (electronApp) {
      return path.join(electronApp.getAppPath(), HOOKS_DIR_NAME)
    }
  } catch {
    // Fall through to cwd fallback below.
  }

  return path.resolve(process.cwd(), HOOKS_DIR_NAME)
}

export function getManagedHooksDirectory(): string {
  if (cachedHooksDir) {
    return cachedHooksDir
  }

  const envOverride = process.env.YGG_HOOKS_DIRECTORY?.trim()
  if (envOverride) {
    cachedHooksDir = path.resolve(envOverride)
    return cachedHooksDir
  }

  const electronApp = getElectronApp()
  if (electronApp) {
    cachedHooksDir = path.join(electronApp.getPath('userData'), HOOKS_DIR_NAME)
    return cachedHooksDir
  }

  cachedHooksDir = path.resolve(process.cwd(), HOOKS_DIR_NAME)
  return cachedHooksDir
}

export function getManagedHooksWorkingDirectory(): string {
  return path.dirname(getManagedHooksDirectory())
}

export async function ensureManagedHooksInitialized(): Promise<string> {
  const managedHooksDir = getManagedHooksDirectory()
  await fsPromises.mkdir(managedHooksDir, { recursive: true })

  const bundledHooksDir = resolveBundledHooksDirectory()
  const normalizedManaged = path.resolve(managedHooksDir)
  const normalizedBundled = path.resolve(bundledHooksDir)

  if (normalizedManaged === normalizedBundled) {
    return managedHooksDir
  }

  if (!(await pathExists(bundledHooksDir))) {
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
  }

  return managedHooksDir
}
