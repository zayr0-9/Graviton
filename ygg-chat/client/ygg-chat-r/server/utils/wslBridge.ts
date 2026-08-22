import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Cached default distro
let defaultDistro: string | null = null

/**
 * Check if the current platform is Windows
 */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

// ============================================================================
// Cross-platform path type detection
// ============================================================================

export type PathType = 'linux' | 'windows' | 'relative'

/**
 * Detect path type by format (platform-agnostic)
 * - 'linux': Absolute Linux/POSIX path (starts with /)
 * - 'windows': Windows path (drive letter C:\ or UNC \\wsl$\...)
 * - 'relative': Relative path (./foo, foo/bar, etc.)
 */
export function detectPathType(filePath: string): PathType {
  const trimmed = filePath.trim()
  if (!trimmed) return 'relative'

  // Windows drive letter (C:\, D:/, etc.)
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return 'windows'

  // Windows UNC path (\\wsl$\..., \\server\...)
  if (/^[\\/]{2}/.test(trimmed)) return 'windows'

  // Absolute Linux/POSIX path
  if (trimmed.startsWith('/')) return 'linux'

  return 'relative'
}

/**
 * Determine if command should execute through WSL
 * Only true when running on Windows - on macOS/Linux tools run natively
 */
export function shouldUseWSL(): boolean {
  return isWindows()
}

/**
 * Get the default WSL distribution with robust fallback and caching
 */
export async function getDefaultDistro(): Promise<string> {
  if (defaultDistro) return defaultDistro

  try {
    // Try verbose list to find the default (marked with *)
    // wsl.exe outputs UTF-16LE, so we must read as buffer and decode explicitly
    const { stdout: buffer } = await execAsync('wsl.exe --list --verbose', { encoding: 'buffer' })
    const stdout = buffer.toString('utf16le').replace(/^\uFEFF/, '') // Remove BOM if present
    const lines = stdout.split('\n')

    for (const line of lines) {
      if (line.trim().startsWith('*')) {
        // Format example: * Ubuntu Running 2
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 2) {
          defaultDistro = parts[1]
          return defaultDistro
        }
      }
    }

    // Fallback to simple list if verbose parsing fails
    const { stdout: simpleBuffer } = await execAsync('wsl.exe --list --quiet', { encoding: 'buffer' })
    const simpleOut = simpleBuffer.toString('utf16le').replace(/^\uFEFF/, '')
    const firstDistro = simpleOut.split(/\s+/)[0]
    if (firstDistro) {
      defaultDistro = firstDistro
      return defaultDistro
    }

    throw new Error('No WSL distributions found')
  } catch (error) {
    console.error('[LocalServer] Failed to detect WSL distro:', error)
    // Final fallback
    return 'Ubuntu'
  }
}

/**
 * Check if a path is a WSL path (starts with / and not a drive letter)
 * Only relevant if running on Windows.
 */
export function isWSLPath(filePath: string): boolean {
  if (!isWindows()) return false

  const trimmedPath = filePath.trim()
  const startsWithSlash = trimmedPath.startsWith('/')
  const isDriveLetter = trimmedPath.match(/^[a-zA-Z]:/)

  return startsWithSlash && !isDriveLetter
}

/**
 * Normalize a native path into a WSL-friendly path (/mnt/<drive>/... or equivalent)
 */
export function toWslPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) {
    return trimmed
  }

  // Convert backslashes to forward slashes first
  let normalized = trimmed.replace(/\\/g, '/')
  let lowerNormalized = normalized.toLowerCase()
  const isUncWSLPath = lowerNormalized.startsWith('//wsl$')

  // Collapse duplicate slashes only when it's not a UNC WSL path
  if (!isUncWSLPath) {
    normalized = normalized.replace(/\\+/g, '/')
    lowerNormalized = normalized.toLowerCase()
  }

  if (isUncWSLPath) {

    const withoutLeadingSlashes = normalized.replace(/^\/+/, '')
    const segments = withoutLeadingSlashes.split('/').filter(Boolean)
    if (segments.length >= 2 && segments[0].toLowerCase() === 'wsl$') {
      const remainder = segments.slice(2).join('/')
      return remainder ? `/${remainder}` : '/'
    }
  }

  if (normalized.startsWith('/')) {
    return normalized
  }

  const driveMatch = lowerNormalized.match(/^([a-zA-Z]):\/(.*)$/)
  if (driveMatch) {
    const drive = driveMatch[1]
    const rest = driveMatch[2]
    return `/mnt/${drive}/${rest}`
  }

  return normalized
}

export async function resolveToWindowsPath(filePath: string): Promise<string> {
  // If not windows, just return the path
  if (!isWindows()) {
    return filePath
  }

  // Check if it looks like a WSL path (starts with / and not a drive letter)
  const trimmedPath = filePath.trim()
  if (!isWSLPath(trimmedPath)) {
    return filePath
  }

  // Check for Git Bash / MinGW style paths (e.g. /c/Users/...)
  const gitBashMatch = trimmedPath.match(/^\/([a-zA-Z])\/(.*)$/)
  if (gitBashMatch) {
    const drive = gitBashMatch[1]
    const rest = gitBashMatch[2]
    return `${drive}:${rest ? '\\' + rest.replace(/\//g, '\\') : '\\'}`
  }

  try {
    const distro = await getDefaultDistro()

    // Ensure we don't double-prefix if it's already a UNC path
    if (trimmedPath.startsWith('\\\\wsl$')) return trimmedPath

    // Handle relative paths if any, though usually tools send absolute
    const cleanPath = trimmedPath.replace(/\//g, '\\')

    // If path starts with \, remove it to append cleanly
    const finalPath = cleanPath.startsWith('\\') ? cleanPath.substring(1) : cleanPath

    const uncPath = `\\\\wsl$\\${distro}\\${finalPath}`
    return uncPath
  } catch (err) {
    console.warn('[LocalServer] Failed to resolve WSL path, using original:', err)
    return filePath
  }
}

export async function getWSLCommandArgs(
  command: string,
  args: string[] = [],
  cwd?: string
): Promise<[string, string[]]> {
  const distro = await getDefaultDistro()
  const finalArgs = ['-d', distro]

  if (cwd) {
    finalArgs.push('--cd', cwd)
  }

  finalArgs.push('-e', command, ...args)

  return ['wsl.exe', finalArgs]
}
