import path from 'path'
import { toWslPath } from './wslBridge.js'

function normalizeForComparison(candidatePath: string, usePosix: boolean): string {
  const trimmed = candidatePath.trim()
  if (!trimmed) return trimmed

  if (usePosix) {
    const normalized = toWslPath(trimmed)
    return normalized.startsWith('/') ? path.posix.normalize(normalized) : path.posix.resolve('/', normalized)
  }

  return path.resolve(trimmed)
}

function isWithinDirectory(targetPath: string, parentPath: string, usePosix: boolean): boolean {
  const pathModule = usePosix ? path.posix : path
  const normalizedTarget = normalizeForComparison(targetPath, usePosix)
  const normalizedParent = normalizeForComparison(parentPath, usePosix)
  const relative = pathModule.relative(normalizedParent, normalizedTarget)
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative))
}

function getManagedToolRoots(usePosix: boolean): string[] {
  const roots = new Set<string>()

  const addRoot = (candidatePath?: string | null) => {
    if (!candidatePath || !candidatePath.trim()) return
    roots.add(normalizeForComparison(candidatePath, usePosix))
  }

  const userDataPath = process.env.YGG_APP_USER_DATA?.trim()
  if (userDataPath) {
    addRoot(path.join(userDataPath, '.ygg'))
    addRoot(path.join(userDataPath, 'custom-tools'))
    addRoot(path.join(userDataPath, 'generated_images'))
  }

  const hooksDir = process.env.YGG_HOOKS_DIRECTORY?.trim()
  if (hooksDir) {
    addRoot(hooksDir)
  }

  const themeDir = process.env.YGG_THEME_DIRECTORY?.trim()
  if (themeDir) {
    addRoot(themeDir)
  }

  const customToolsOverride = process.env.YGG_CUSTOM_TOOLS_DIRECTORY?.trim()
  if (customToolsOverride) {
    const normalizedOverride = customToolsOverride.replace(/[\\/]+$/, '')
    if (path.basename(normalizedOverride).toLowerCase() === 'custom-tools') {
      addRoot(normalizedOverride)
    } else {
      addRoot(path.join(normalizedOverride, 'custom-tools'))
    }
  }

  return Array.from(roots)
}

export function isManagedToolPath(candidatePath: string, usePosix: boolean): boolean {
  const normalizedCandidate = normalizeForComparison(candidatePath, usePosix)
  return getManagedToolRoots(usePosix).some(rootPath => isWithinDirectory(normalizedCandidate, rootPath, usePosix))
}
