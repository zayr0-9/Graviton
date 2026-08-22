import fs from 'fs/promises'
import path from 'path'
import { isManagedToolPath } from '../utils/managedToolPaths.js'
import { isWSLPath, resolveToWindowsPath } from '../utils/wslBridge.js'

function isManagedPathException(workspacePath: string, targetPath: string, usePosix: boolean): boolean {
  const workspaceIsManagedPath = isManagedToolPath(workspacePath, usePosix)
  const targetIsManagedPath = isManagedToolPath(targetPath, usePosix)
  return !workspaceIsManagedPath && targetIsManagedPath
}

/**
 * Deletes a file at the specified path
 * @param filePath - Absolute or relative path to the file to delete
 * @param operationMode - Optional operation mode ('plan' | 'execute')
 * @param cwd - Optional workspace directory for path resolution and restriction
 * @returns Promise<void>
 * @throws Error if file doesn't exist or deletion fails
 */
export async function deleteFile(filePath: string, operationMode?: 'plan' | 'execute', cwd?: string): Promise<void> {
  // Block file deletion in plan mode
  if (operationMode === 'plan') {
    throw new Error(
      'You are in planning mode. File modification is not allowed. Please describe your implementation plan instead. Do not try to edit the code or make changes. Do not use bash to skip this warning.'
    )
  }

  try {
    // Resolve the path to handle relative paths
    let resolvedPath = filePath
    const willBeWsl = isWSLPath(filePath)

    // For WSL paths, resolve to absolute Linux path first (for validation)
    if (willBeWsl) {
      // Make path absolute using POSIX rules (before UNC conversion)
      if (!filePath.startsWith('/')) {
        resolvedPath = cwd ? `${cwd.replace(/\/$/, '')}/${filePath}` : filePath
      }
    } else {
      const basePath = cwd || process.cwd()
      resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath)
    }

    // Workspace validation BEFORE UNC conversion (compare Linux to Linux)
    if (cwd) {
      if (willBeWsl) {
        // Both are Linux paths - compare directly using POSIX rules
        const normalizedCwd = cwd.replace(/\/$/, '')
        const normalizedPath = resolvedPath.replace(/\/$/, '')
        const outsideWorkspace = !normalizedPath.startsWith(normalizedCwd + '/') && normalizedPath !== normalizedCwd
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, true)) {
          throw new Error(
            `Access denied: Path '${filePath}' is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
          )
        }
      } else {
        // Windows or native paths - use Node's path module
        const normalizedCwd = path.resolve(cwd)
        const normalizedPath = path.resolve(resolvedPath)
        const outsideWorkspace = !normalizedPath.startsWith(normalizedCwd + path.sep) && normalizedPath !== normalizedCwd
        if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, false)) {
          throw new Error(
            `Access denied: Path '${filePath}' is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
          )
        }
      }
    }

    // NOW convert to UNC for filesystem access
    if (willBeWsl) {
      resolvedPath = await resolveToWindowsPath(resolvedPath)
    }

    // Check if file exists
    try {
      await fs.access(resolvedPath)
    } catch {
      throw new Error(`File not found: ${resolvedPath}`)
    }

    // Delete the file
    await fs.unlink(resolvedPath)
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to delete file: ${error.message}`)
    }
    throw new Error('Failed to delete file: Unknown error')
  }
}

/**
 * Safely deletes a file with additional validation
 * @param filePath - Path to the file to delete
 * @param allowedExtensions - Optional array of allowed file extensions
 * @param operationMode - Optional operation mode ('plan' | 'execute')
 * @param cwd - Optional workspace directory for path resolution and restriction
 * @returns Promise<void>
 * @throws Error if validation fails or deletion fails
 */
export async function safeDeleteFile(
  filePath: string,
  allowedExtensions?: string[],
  operationMode?: 'plan' | 'execute',
  cwd?: string
): Promise<void> {
  // Block file deletion in plan mode
  if (operationMode === 'plan') {
    throw new Error(
      'You are in planning mode. File modification is not allowed. Please describe your implementation plan instead. Do not try to edit the code or make changes. Do not use bash to skip this warning.'
    )
  }

  let resolvedPath = filePath
  const willBeWsl = isWSLPath(filePath)

  // For WSL paths, resolve to absolute Linux path first (for validation)
  if (willBeWsl) {
    // Make path absolute using POSIX rules (before UNC conversion)
    if (!filePath.startsWith('/')) {
      resolvedPath = cwd ? `${cwd.replace(/\/$/, '')}/${filePath}` : filePath
    }
  } else {
    const basePath = cwd || process.cwd()
    resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath)
  }

  // Workspace validation BEFORE UNC conversion (compare Linux to Linux)
  if (cwd) {
    if (willBeWsl) {
      // Both are Linux paths - compare directly using POSIX rules
      const normalizedCwd = cwd.replace(/\/$/, '')
      const normalizedPath = resolvedPath.replace(/\/$/, '')
      const outsideWorkspace = !normalizedPath.startsWith(normalizedCwd + '/') && normalizedPath !== normalizedCwd
      if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, true)) {
        throw new Error(
          `Access denied: Path '${filePath}' is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
        )
      }
    } else {
      // Windows or native paths - use Node's path module
      const normalizedCwd = path.resolve(cwd)
      const normalizedPath = path.resolve(resolvedPath)
      const outsideWorkspace = !normalizedPath.startsWith(normalizedCwd + path.sep) && normalizedPath !== normalizedCwd
      if (outsideWorkspace && !isManagedPathException(normalizedCwd, normalizedPath, false)) {
        throw new Error(
          `Access denied: Path '${filePath}' is outside the workspace '${cwd}'. File operations are restricted to the workspace directory.`
        )
      }
    }
  }

  // NOW convert to UNC for filesystem access
  if (willBeWsl) {
    resolvedPath = await resolveToWindowsPath(resolvedPath)
  }

  // Validate file extension if provided
  if (allowedExtensions && allowedExtensions.length > 0) {
    const fileExt = path.extname(resolvedPath).toLowerCase()
    if (!allowedExtensions.some(ext => ext.toLowerCase() === fileExt)) {
      throw new Error(`File extension '${fileExt}' not allowed. Allowed extensions: ${allowedExtensions.join(', ')}`)
    }
  }

  // Prevent deletion of sensitive system files/directories
  const sensitivePatterns = ['/etc/passwd', '/etc/shadow', '/proc', '/sys', '/dev', '.env', '.git', 'node_modules']

  const normalizedPath = path.normalize(resolvedPath)
  if (sensitivePatterns.some(pattern => normalizedPath.includes(pattern))) {
    throw new Error(`Cannot delete sensitive system file or directory: ${resolvedPath}`)
  }

  // Use the basic delete function (pass cwd for consistent validation)
  await deleteFile(resolvedPath, undefined, cwd)
}

export default {
  deleteFile,
  safeDeleteFile,
}
