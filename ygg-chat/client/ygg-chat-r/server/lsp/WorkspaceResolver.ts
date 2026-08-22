import fs from 'fs'
import path from 'path'

function fileOrDirectoryExists(absolutePath: string): boolean {
  try {
    fs.accessSync(absolutePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizeCandidateDirectory(filePath: string): string {
  const resolved = path.resolve(filePath)
  if (!fileOrDirectoryExists(resolved)) {
    return path.dirname(resolved)
  }

  try {
    const stats = fs.statSync(resolved)
    return stats.isDirectory() ? resolved : path.dirname(resolved)
  } catch {
    return path.dirname(resolved)
  }
}

export function findWorkspaceRoot(filePath: string, rootMarkers: string[]): string {
  const normalizedMarkers = Array.from(new Set(rootMarkers.map(marker => String(marker || '').trim()).filter(Boolean)))
  let currentDirectory = normalizeCandidateDirectory(filePath)

  while (true) {
    if (
      normalizedMarkers.some(marker => {
        const markerPath = path.join(currentDirectory, marker)
        return fileOrDirectoryExists(markerPath)
      })
    ) {
      return currentDirectory
    }

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      return normalizeCandidateDirectory(filePath)
    }
    currentDirectory = parentDirectory
  }
}
