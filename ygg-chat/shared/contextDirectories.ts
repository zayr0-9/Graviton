/**
 * Context directory settings (docs/claude_code_context_loading_rules.md §11.4).
 *
 * Every rule that names `.claude/` in Claude Code reads `<configDir>/` in Graviton,
 * where `<configDir>` is a user choice: `.ygg`, `.claude`, both, or a custom list.
 * The renderer stores the choice in localStorage and forwards it on every chat
 * request; the server falls back to environment defaults for headless runs.
 *
 * Instruction files (`AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`) are NOT affected
 * by this setting — they sit at the directory root and `.claude/CLAUDE.md` is a fixed
 * compatibility path (§11.4, first paragraph).
 */

export interface ContextDirectorySettings {
  /** Ordered list of in-repo directory names to READ. Deduped by real path at load time. */
  readDirs: string[]
  /** Single directory name to WRITE (agent memory, generated rules/skills). Must be in readDirs. */
  writeDir: string
}

export type ContextDirectoryPreset = 'ygg' | 'claude' | 'both' | 'custom'

export const DEFAULT_CONTEXT_DIRECTORY_SETTINGS: ContextDirectorySettings = Object.freeze({
  readDirs: ['.ygg', '.claude'],
  writeDir: '.ygg',
}) as ContextDirectorySettings

export const CONTEXT_DIRECTORY_PRESETS: Record<Exclude<ContextDirectoryPreset, 'custom'>, ContextDirectorySettings> = {
  ygg: { readDirs: ['.ygg'], writeDir: '.ygg' },
  claude: { readDirs: ['.claude'], writeDir: '.claude' },
  both: { readDirs: ['.ygg', '.claude'], writeDir: '.ygg' },
}

const MAX_DIRECTORY_NAME_LENGTH = 64

/**
 * A config directory name is one path segment: no separators, no `..`, no leading `~`,
 * 1 to 64 characters. A leading `.` is allowed but not required (§11.4 validation).
 */
export function validateContextDirectoryName(value: string): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return 'Directory name is required.'
  if (trimmed.length > MAX_DIRECTORY_NAME_LENGTH) return `Directory name must be ${MAX_DIRECTORY_NAME_LENGTH} characters or fewer.`
  if (trimmed === '.' || trimmed === '..') return 'Directory name cannot be "." or "..".'
  if (trimmed.startsWith('~')) return 'Directory name cannot start with "~".'
  if (/[\\/\0]/.test(trimmed)) return 'Directory name cannot contain path separators.'
  if (trimmed.includes('..')) return 'Directory name cannot contain "..".'
  return null
}

/**
 * Normalise an untrusted value (request body, localStorage, env) into a valid
 * settings object. Invalid or missing input falls back to the defaults; invalid
 * entries inside an otherwise valid list are dropped. The write directory must be
 * one of the read directories, otherwise it snaps to the first read directory.
 */
export function normalizeContextDirectorySettings(
  value: unknown,
  fallback: ContextDirectorySettings = DEFAULT_CONTEXT_DIRECTORY_SETTINGS
): ContextDirectorySettings {
  if (!value || typeof value !== 'object') return { readDirs: [...fallback.readDirs], writeDir: fallback.writeDir }
  const raw = value as { readDirs?: unknown; writeDir?: unknown }
  const readDirs: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.readDirs)) {
    for (const entry of raw.readDirs) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (validateContextDirectoryName(trimmed)) continue
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      readDirs.push(trimmed)
    }
  }
  if (readDirs.length === 0) return { readDirs: [...fallback.readDirs], writeDir: fallback.writeDir }
  const requestedWrite = typeof raw.writeDir === 'string' ? raw.writeDir.trim() : ''
  const writeDir = requestedWrite && seen.has(requestedWrite) ? requestedWrite : readDirs[0]
  return { readDirs, writeDir }
}

/** Which preset a settings object corresponds to, for the Settings radio group. */
export function detectContextDirectoryPreset(settings: ContextDirectorySettings): ContextDirectoryPreset {
  for (const [preset, candidate] of Object.entries(CONTEXT_DIRECTORY_PRESETS) as Array<
    [Exclude<ContextDirectoryPreset, 'custom'>, ContextDirectorySettings]
  >) {
    if (
      candidate.writeDir === settings.writeDir &&
      candidate.readDirs.length === settings.readDirs.length &&
      candidate.readDirs.every((dir, index) => dir === settings.readDirs[index])
    ) {
      return preset
    }
  }
  return 'custom'
}

/**
 * Server-side defaults from the environment (§11.4 "Server default"):
 *   YGG_CONTEXT_DIRECTORIES=.ygg,.claude   comma list, read order
 *   YGG_CONTEXT_WRITE_DIRECTORY=.ygg       must be in the list
 * A request value always overrides these.
 */
export function resolveContextDirectorySettingsFromEnv(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
): ContextDirectorySettings {
  const listRaw = env.YGG_CONTEXT_DIRECTORIES
  const readDirs =
    typeof listRaw === 'string' && listRaw.trim()
      ? listRaw
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
      : undefined
  return normalizeContextDirectorySettings(
    { readDirs: readDirs ?? DEFAULT_CONTEXT_DIRECTORY_SETTINGS.readDirs, writeDir: env.YGG_CONTEXT_WRITE_DIRECTORY },
    DEFAULT_CONTEXT_DIRECTORY_SETTINGS
  )
}
