import { hasFullToolAccess } from '../toolAccessContext.js'
import * as fs from 'fs'
import * as path from 'path'
import { getManagedToolRoots, isManagedToolPath } from '../utils/managedToolPaths.js'
import { isWSLPath, resolveToWindowsPath, toWslPath } from '../utils/wslBridge.js'

export interface CreateFileOptions {
  createParentDirs?: boolean
  overwrite?: boolean
  executable?: boolean
  operationMode?: 'plan' | 'execute'
  cwd?: string // Workspace directory for path resolution and restriction
}

export interface CreateFileResult {
  success: boolean
  created: boolean
  sizeBytes: number
  message: string
}

function resolveWslLikeAbsolutePath(inputPath: string, cwd?: string): string {
  const normalizedInput = toWslPath(inputPath)

  if (normalizedInput.startsWith('/')) {
    return path.posix.normalize(normalizedInput)
  }

  const normalizedBase = cwd ? toWslPath(cwd) : toWslPath(process.cwd())
  const basePath = normalizedBase.startsWith('/') ? normalizedBase : path.posix.resolve('/', normalizedBase)

  return path.posix.resolve(basePath, normalizedInput)
}

function assertWithinWorkspace(inputPath: string, resolvedPath: string, cwd: string, usePosix: boolean): void {
  if (hasFullToolAccess()) return
  if (usePosix) {
    const workspace = resolveWslLikeAbsolutePath(cwd)
    const target = resolveWslLikeAbsolutePath(resolvedPath)
    const rel = path.posix.relative(workspace, target)

    if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) {
      const workspaceIsManagedPath = isManagedToolPath(workspace, true)
      const targetIsManagedPath = isManagedToolPath(target, true)
      if (!workspaceIsManagedPath && targetIsManagedPath) {
        return
      }
      throw new Error(
        `Access denied: Path '${inputPath}' resolves to '${resolvedPath}' which is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
      )
    }
    return
  }

  const workspace = path.resolve(cwd)
  const target = path.resolve(resolvedPath)
  const rel = path.relative(workspace, target)

  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    const workspaceIsManagedPath = isManagedToolPath(workspace, false)
    const targetIsManagedPath = isManagedToolPath(target, false)
    if (!workspaceIsManagedPath && targetIsManagedPath) {
      return
    }
    throw new Error(
      `Access denied: Path '${inputPath}' resolves to '${resolvedPath}' which is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
    )
  }
}

// Resolve existing ancestors before creating directories. Reject dangling links
// rather than following them into a target that does not yet exist.
async function canonicalDestination(target: string): Promise<string> {
  try {
    await fs.promises.lstat(target)
    return await fs.promises.realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      if ((await fs.promises.lstat(target)).isSymbolicLink()) throw new Error('Access denied: dangling symlink')
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
    }
    const parent = path.dirname(target)
    if (parent === target) throw error
    return path.join(await canonicalDestination(parent), path.basename(target))
  }
}

async function checkedDestination(target: string, cwd?: string): Promise<string> {
  const canonical = await canonicalDestination(target)
  if (!cwd || hasFullToolAccess()) return canonical
  const nativeRoot = isWSLPath(cwd) ? await resolveToWindowsPath(cwd) : cwd
  const root = await fs.promises.realpath(nativeRoot)
  const within = (candidate: string, base: string) => {
    const rel = path.relative(base, candidate)
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }
  if (within(canonical, root)) return canonical
  const managed = await Promise.all(getManagedToolRoots(false).map(canonicalDestination))
  if (!managed.some(base => within(root, base)) && managed.some(base => within(canonical, base))) return canonical
  throw new Error('Access denied: symlink target resolves outside the workspace')
}

/**
 * Create a file with the specified content.
 * Supports automatic parent directory creation and optional overwrite.
 *
 * @param filePath - The path to the file (absolute or relative)
 * @param content - The content to write to the file
 * @param options - Optional settings for file creation
 * @returns Promise<CreateFileResult>
 */
export async function createTextFile(
  filePath: string,
  content: string = '',
  options: CreateFileOptions = {}
): Promise<CreateFileResult> {
  const { createParentDirs = true, overwrite = false, executable = false, operationMode, cwd } = options

  // Block file creation in plan mode
  if (operationMode === 'plan') {
    return {
      success: false,
      created: false,
      sizeBytes: 0,
      message:
        'You are in planning mode. File modification is not allowed. Please describe your implementation plan instead. Do not try to edit the code or make changes. Do not use bash to skip this warning.',
    }
  }

  try {
    let targetPath = filePath
    let pathType: 'windows' | 'wsl' | 'posix' = 'posix'
    const willBeWsl = isWSLPath(filePath)

    if (willBeWsl) {
      pathType = 'wsl'
      targetPath = resolveWslLikeAbsolutePath(filePath, cwd)
    } else {
      const basePath = cwd || process.cwd()
      targetPath = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath)
      if (/^[a-zA-Z]:[\\/]/.test(targetPath)) {
        pathType = 'windows'
      }
    }

    if (cwd) {
      assertWithinWorkspace(filePath, targetPath, cwd, pathType === 'wsl')
    }

    let windowsPath = targetPath
    if (pathType === 'wsl') {
      windowsPath = await resolveToWindowsPath(targetPath)
    }

    windowsPath = await checkedDestination(windowsPath, cwd)

    const fileExists = await fs.promises
      .access(windowsPath, fs.constants.F_OK)
      .then(() => true)
      .catch(() => false)

    if (fileExists && !overwrite) {
      return {
        success: false,
        created: false,
        sizeBytes: 0,
        message: `File already exists at ${targetPath}. Use overwrite option to replace it.`,
      }
    }

    let dirsCreated = false

    const windowsParentDir = path.dirname(windowsPath)

    if (createParentDirs) {
      try {
        await fs.promises.mkdir(windowsParentDir, { recursive: true })
        dirsCreated = true
      } catch (mkdirError: any) {
        return {
          success: false,
          created: false,
          sizeBytes: 0,
          message: `Failed to create parent directories: ${mkdirError.message}`,
        }
      }
    } else {
      const dirExists = await fs.promises
        .access(windowsParentDir, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false)

      if (!dirExists) {
        return {
          success: false,
          created: false,
          sizeBytes: 0,
          message: `Parent directory does not exist: ${windowsParentDir}`,
        }
      }
    }

    // Recheck after mkdir and use exclusive creation to close the existence-check
    // race. NOFOLLOW also rejects a leaf symlink substituted after validation.
    windowsPath = await checkedDestination(windowsPath, cwd)
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT |
      (overwrite ? 0 : fs.constants.O_EXCL) | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    const handle = await fs.promises.open(windowsPath, flags, 0o666)
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Destination must be a regular file')
      if (overwrite) await handle.truncate(0)
      await handle.writeFile(content, 'utf8')
    } finally { await handle.close() }

    if (executable && (process.platform !== 'win32' || pathType === 'wsl')) {
      try {
        await fs.promises.chmod(windowsPath, 0o755)
      } catch (chmodError: any) {
        console.warn(`Warning: Could not make file executable: ${chmodError.message}`)
      }
    }

    const stats = await fs.promises.stat(windowsPath)

    const message = dirsCreated
      ? `File created successfully at ${targetPath} (parent directories created)`
      : `File created successfully at ${targetPath}`

    return {
      success: true,
      created: true,
      sizeBytes: stats.size,
      message,
    }
  } catch (error: any) {
    return {
      success: false,
      created: false,
      sizeBytes: 0,
      message: `Error creating file: ${error.message}`,
    }
  }
}

export default createTextFile
