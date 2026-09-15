// server/context/autoMemory.ts
// Auto memory index (docs §4.2): `<dataDir>/.ygg/memory/projects/<slug>/MEMORY.md`,
// loaded at session start as the first 200 lines or 25 KB, whichever comes first.

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { LABEL_AUTO_MEMORY, type ContextInjectionEntry } from '../../../../shared/contextInjection.js'

export const MEMORY_INDEX_FILE = 'MEMORY.md'
export const MEMORY_INDEX_MAX_LINES = 200
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024

/** Walk up from `startPath` to the nearest directory holding `.git` (dir or file). */
export function findGitRoot(startPath: string): string | null {
  let cursor = path.resolve(startPath)
  for (;;) {
    try {
      if (fsSync.existsSync(path.join(cursor, '.git'))) return cursor
    } catch {
      // Unreadable directory: keep walking.
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

/**
 * §4.2 "Slug": derived from the git repo root so every worktree and subdirectory of
 * one repo shares one memory directory. Outside git, the root path itself.
 * Override with `YGG_MEMORY_PROJECT_DIR_NAME`.
 */
export function resolveProjectMemorySlug(rootPath: string, env: Record<string, string | undefined> = process.env): string {
  const override = env.YGG_MEMORY_PROJECT_DIR_NAME?.trim()
  if (override) return override.replace(/[\\/\0]/g, '-')
  const base = findGitRoot(rootPath) ?? path.resolve(rootPath)
  return base.replace(/[^A-Za-z0-9._-]+/g, '-')
}

export interface AutoMemoryLocationOptions {
  dataDir: string
  rootPath: string
  /** `autoMemoryDirectory` setting: absolute or `~/` path. */
  directoryOverride?: string | null
  homeDir?: string
  env?: Record<string, string | undefined>
}

export function resolveAutoMemoryDirectory(options: AutoMemoryLocationOptions): string {
  const env = options.env ?? process.env
  const override = options.directoryOverride?.trim() || env.YGG_AUTO_MEMORY_DIRECTORY?.trim()
  if (override) {
    if (override.startsWith('~/') || override === '~') {
      const home = options.homeDir ?? (env.HOME || env.USERPROFILE || '')
      return path.resolve(path.join(home, override.slice(1)))
    }
    return path.resolve(override)
  }
  return path.join(options.dataDir, '.ygg', 'memory', 'projects', resolveProjectMemorySlug(options.rootPath, env))
}

export function isAutoMemoryDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.YGG_DISABLE_AUTO_MEMORY || '')
}

/** Head-read: first 200 lines or first 25 KB, whichever comes first. Extra content is dropped. */
export function truncateMemoryIndex(content: string): { text: string; truncated: boolean } {
  let text = content
  let truncated = false
  const lines = text.split(/\r?\n/)
  if (lines.length > MEMORY_INDEX_MAX_LINES) {
    text = lines.slice(0, MEMORY_INDEX_MAX_LINES).join('\n')
    truncated = true
  }
  if (Buffer.byteLength(text, 'utf8') > MEMORY_INDEX_MAX_BYTES) {
    const buffer = Buffer.from(text, 'utf8').subarray(0, MEMORY_INDEX_MAX_BYTES)
    text = buffer.toString('utf8').replace(/�+$/, '')
    truncated = true
  }
  return { text, truncated }
}

export async function readMemoryIndex(directory: string): Promise<ContextInjectionEntry | null> {
  const file = path.join(directory, MEMORY_INDEX_FILE)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  const { text } = truncateMemoryIndex(raw)
  if (!text.trim()) return null
  return { path: file, label: LABEL_AUTO_MEMORY, text, reason: 'memory' }
}

/**
 * Short system-prompt section telling the model where its memory lives. Stable per
 * conversation (the directory is a pure function of the root), so it caches.
 */
export function buildAutoMemoryPrompt(directory: string): string {
  return [
    '# Memory',
    '',
    `You have a persistent file-based memory at \`${directory}\`. Each memory is one markdown file holding one fact, with frontmatter:`,
    '',
    '```markdown',
    '---',
    'name: <short-kebab-case-slug>',
    'description: <one-line summary>',
    'type: user | feedback | project | reference',
    '---',
    '',
    '<the fact>',
    '```',
    '',
    `After writing a file, add a one-line pointer in \`${MEMORY_INDEX_FILE}\` in the same directory (\`- [Title](file.md) — hook\`). ` +
      `\`${MEMORY_INDEX_FILE}\` is loaded into context at the start of every conversation (first ${MEMORY_INDEX_MAX_LINES} lines or ${MEMORY_INDEX_MAX_BYTES / 1024} KB); keep it an index, never put memory content there. ` +
      'Update an existing file instead of creating a duplicate. Do not save what the repository already records.',
  ].join('\n')
}
