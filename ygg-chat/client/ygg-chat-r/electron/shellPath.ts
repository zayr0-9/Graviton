import { fileURLToPath } from 'node:url'

// Accept existing plain-path callers as well as Markdown file URLs.
export function normalizeShellPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A nonempty file or folder path is required')
  }

  const path = /^file:/i.test(value) ? fileURLToPath(value) : value
  if (path.includes('\0')) {
    throw new Error('File or folder paths cannot contain NUL characters')
  }
  return path
}
