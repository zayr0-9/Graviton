import { glob } from 'glob'
import os from 'os'
import * as path from 'path'
import { detectPathType, isWindows, resolveToWindowsPath, toWslPath } from '../utils/wslBridge.js'

const DEFAULT_MAX_MATCHES = 3000
const DEFAULT_TIMEOUT_MS = 5000
const DIRECTORY_DEPTH_LIMIT = 6
const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/.ygg/memory/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/tmp/**',
  '**/temp/**',
  '**/*.min.js',
]

const HOMEDIR = os.homedir()

async function ensureWithinWorkspace(cwd: string): Promise<{ resolved: string; type: 'windows' | 'wsl' }> {
  const pathType = detectPathType(cwd)

  // On Windows with a Linux path, resolve to UNC path for Node.js fs access
  if (isWindows() && pathType === 'linux') {
    const winPath = await resolveToWindowsPath(cwd)
    return { resolved: winPath, type: 'wsl' }
  }

  const resolved = path.resolve(cwd)

  // Basic safety check: don't allow root or home dir as cwd to prevent scanning whole system
  if (resolved === '/' || resolved === path.parse(resolved).root || resolved === HOMEDIR) {
    // If explicit request, maybe allow? But safer to restrict.
    // However, in local mode, user might want to scan arbitrary dirs.
    // Let's just warn or allow if it's intentional.
    // For now, we'll allow it if it's not the fs root.
  }

  return { resolved, type: isWindows() ? 'windows' : 'wsl' }
}

function mergeIgnorePatterns(defaults: string[], custom?: string | string[]): string[] {
  if (!custom) return defaults
  const userPatterns = Array.isArray(custom) ? custom : [custom]
  const cleaned = userPatterns.filter(Boolean)
  return Array.from(new Set([...defaults, ...cleaned]))
}

function enforcePatternDepth(pattern: string): string {
  const segments = pattern.split('/').filter(Boolean)
  if (segments.length <= DIRECTORY_DEPTH_LIMIT) return pattern
  return segments.slice(0, DIRECTORY_DEPTH_LIMIT).join('/')
}

export interface GlobOptions {
  cwd?: string
  ignore?: string | string[]
  dot?: boolean
  absolute?: boolean
  mark?: boolean
  nosort?: boolean
  nocase?: boolean
  nodir?: boolean
  follow?: boolean
  realpath?: boolean
  stat?: boolean
  withFileTypes?: boolean
  maxMatches?: number
  timeoutMs?: number
}

export interface GlobResult {
  success: boolean
  matches: string[]
  error?: string
  pattern?: string
  cwd?: string
}

export async function globSearch(pattern: string, options: GlobOptions = {}): Promise<GlobResult> {
  if (!pattern || pattern.trim() === '') {
    return {
      success: false,
      matches: [],
      error: 'Pattern cannot be empty',
    }
  }

  const {
    cwd = process.cwd(),
    ignore,
    dot = false,
    absolute = false,
    mark = false,
    nosort = false,
    nocase = false,
    nodir = false,
    follow = false,
    realpath = false,
    stat = false,
    withFileTypes = false,
    maxMatches = DEFAULT_MAX_MATCHES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  try {
    const { resolved: resolvedCwd, type: resolvedType } = await ensureWithinWorkspace(cwd)
    const sanitizedPattern = enforcePatternDepth(pattern)
    const ignorePatterns = mergeIgnorePatterns(DEFAULT_IGNORE_PATTERNS, ignore)

    const globOptions: any = {
      cwd: resolvedType === 'windows' ? resolvedCwd : toWslPath(resolvedCwd),
      ignore: ignorePatterns,
      dot,
      absolute,
      mark,
      nosort,
      nocase,
      nodir,
      follow,
      realpath,
      stat,
      withFileTypes,
      windowsPathsNoEscape: true,
    }

    let results: any[]
    try {
      // glob v10+ returns a promise directly
      results = (await Promise.race([
        glob(sanitizedPattern, globOptions),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Glob search timed out. Narrow the pattern or specify a smaller cwd.')),
            timeoutMs
          )
        ),
      ])) as any[]
    } catch (error: any) {
      throw new Error(error?.message || 'Glob search failed')
    }

    if (!Array.isArray(results)) {
      throw new Error('Glob search did not return an array of results')
    }

    if (results.length > maxMatches) {
      return {
        success: false,
        matches: [],
        error: `Too many matches (${results.length} > ${maxMatches}). Narrow the pattern or reduce cwd scope.`,
        pattern: sanitizedPattern,
        cwd: resolvedType === 'windows' ? resolvedCwd : toWslPath(resolvedCwd),
      }
    }

    const matches = withFileTypes
      ? (results as any[]).map((dirent: any) => dirent?.fullpath?.() || dirent?.path || String(dirent))
      : (results as string[])

    return {
      success: true,
      matches,
      pattern: sanitizedPattern,
      cwd: resolvedType === 'windows' ? resolvedCwd : toWslPath(resolvedCwd),
    }
  } catch (error: any) {
    return {
      success: false,
      matches: [],
      error: error?.message || 'Glob search failed',
      pattern,
      cwd,
    }
  }
}

export default globSearch
