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

// Retire only the old bundled writer. Preserve saved memories and all other hooks.
export async function retireLegacyMemoryHook(managedHooksDir: string): Promise<void> {
  const scriptPath = path.join(managedHooksDir, 'hooks', 'long_term_memory_stop.py')
  const normalizedScript = scriptPath.replace(/\\/g, '/')
  for (const name of YGG_SETTINGS_FILES) {
    const file = path.join(managedHooksDir, name)
    const raw = await readFileIfExists(file)
    if (!raw) continue
    let settings: any
    try {
      settings = JSON.parse(raw.toString('utf8'))
    } catch {
      // Never overwrite malformed user settings; surface the failure for repair.
      throw new Error(`Cannot retire legacy memory hook: invalid JSON in ${file}`)
    }
    if (!settings?.hooks || typeof settings.hooks !== 'object') continue
    let changed = false
    for (const event of Object.keys(settings.hooks)) {
      const groups = settings.hooks[event]
      if (!Array.isArray(groups)) continue
      settings.hooks[event] = groups.filter((group: any) => {
        if (!Array.isArray(group?.hooks)) return true
        const kept = group.hooks.filter((hook: any) => {
          if (hook?.type !== 'command' || typeof hook.command !== 'string') return true
          const tokens: string[] = (hook.command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [])
            .map((token: string) => token.replace(/^["']|["']$/g, '').replace(/\\/g, '/'))
          const executable = path.posix.basename(tokens[0] ?? '')
          const script = /^(python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/.test(executable) ? tokens[1] : tokens[0]
          const retired = script === '.ygg/hooks/long_term_memory_stop.py' ||
            script === './.ygg/hooks/long_term_memory_stop.py' || script === normalizedScript
          if (retired) changed = true
          return !retired
        })
        const removed = kept.length !== group.hooks.length
        if (removed) group.hooks = kept
        return !removed || kept.length > 0
      })
    }
    if (changed) await writeFileAtomically(file, Buffer.from(`${JSON.stringify(settings, null, 2)}\n`))
  }
  await fsPromises.rm(scriptPath, { force: true })
  const cacheDir = path.join(managedHooksDir, 'hooks', '__pycache__')
  const cached = await fsPromises.readdir(cacheDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  for (const name of cached) {
    if (/^long_term_memory_stop\.[\w-]+\.pyc$/.test(name)) {
      await fsPromises.rm(path.join(cacheDir, name), { force: true })
    }
  }
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
    await retireLegacyMemoryHook(managedHooksDir)
    hasInitializedManagedHooks = true
    return managedHooksDir
  }

  if (!(await pathExists(bundledHooksDir))) {
    logHookStorage('bundled hooks directory not found; using managed directory as-is', { bundledHooksDir, managedHooksDir })
    await retireLegacyMemoryHook(managedHooksDir)
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

  await retireLegacyMemoryHook(managedHooksDir)
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
