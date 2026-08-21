// electron/server/toolPathPolicy.ts
// Workspace path validation shared by the built-in tool registry and the
// server route handlers. Moved out of localServer.ts so the tool registry can
// live in the runtime-neutral server graph without importing the composition
// root. The identical logic also exists inside toolRuntimeUtility.ts for the
// sandboxed side of the boundary.

import path from 'path'
import { isManagedToolPath } from '../utils/managedToolPaths.js'

/**
 * Validates and resolves a path to ensure it's within the allowed rootPath scope.
 * Prevents directory traversal attacks.
 */
export function validateAndResolvePath(
  inputPath: string | undefined,
  rootPath: string | undefined,
  fallbackToRoot = true
): string {
  const normalizedInput = typeof inputPath === 'string' ? inputPath.trim() : ''

  // If no input path provided
  if (!normalizedInput) {
    if (fallbackToRoot && rootPath) return rootPath
    return '.'
  }

  // Detect if we should use POSIX logic (WSL paths on Windows)
  // If on Windows, but paths start with '/', treat as WSL/Linux path
  // Boolean(): the && / || chain yields `string | boolean | undefined` when inputPath or
  // rootPath is an empty string. Only ever used as a boolean (below, and by
  // isManagedToolPath), so coercing here changes nothing at runtime.
  const usePosix = Boolean(
    process.platform === 'win32' && ((inputPath && inputPath.startsWith('/')) || (rootPath && rootPath.startsWith('/')))
  )

  const pathModule = usePosix ? path.posix : path

  // If no rootPath constraint, just resolve the path
  if (!rootPath) {
    return pathModule.resolve(normalizedInput)
  }

  const normalizedRoot = pathModule.resolve(rootPath)

  // Resolve to absolute path
  const resolvedPath = pathModule.isAbsolute(normalizedInput)
    ? pathModule.resolve(normalizedInput)
    : pathModule.resolve(normalizedRoot, normalizedInput)

  // Security: Ensure resolved path is within rootPath scope
  const relativeToRoot = pathModule.relative(normalizedRoot, resolvedPath)
  const outsideWorkspace =
    relativeToRoot === '..' || relativeToRoot.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relativeToRoot)

  if (outsideWorkspace) {
    const rootIsManagedPath = isManagedToolPath(normalizedRoot, usePosix)
    const targetIsManagedPath = isManagedToolPath(resolvedPath, usePosix)
    if (!rootIsManagedPath && targetIsManagedPath) {
      return resolvedPath
    }
    throw new Error(`Path must be within workspace: ${rootPath}`)
  }

  return resolvedPath
}

export function resolveToolWorkspaceCwd(requestedCwd: unknown, rootPath: string | undefined): string | undefined {
  const normalizedRequested = typeof requestedCwd === 'string' ? requestedCwd.trim() : ''
  if (!normalizedRequested) {
    return rootPath || undefined
  }
  return validateAndResolvePath(normalizedRequested, rootPath)
}
