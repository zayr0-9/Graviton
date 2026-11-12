import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Accept existing plain-path callers as well as Markdown file URLs.
export function normalizeShellPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A nonempty file or folder path is required')
  }

  let path = /^file:/i.test(value) ? fileURLToPath(value) : value
  // Markdown links can name home-relative paths; the shell does not expand `~` for openPath.
  if (path === '~' || /^~[\\/]/.test(path)) path = join(homedir(), path.slice(1))
  if (path.includes('\0')) {
    throw new Error('File or folder paths cannot contain NUL characters')
  }
  return path
}
