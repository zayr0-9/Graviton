import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'

// Trusted, invocation-local policy. Never read this capability from model tool arguments.
interface ToolAccess {
  fullAccess: boolean
  /** Extra conversation roots (`conversations.additional_cwds`) tools may use besides the cwd. */
  additionalRoots: readonly string[]
}

const toolAccess = new AsyncLocalStorage<ToolAccess>()

export const hasFullToolAccess = (): boolean => toolAccess.getStore()?.fullAccess === true

export const getAdditionalToolRoots = (): readonly string[] => toolAccess.getStore()?.additionalRoots ?? []

export function withToolAccess<T>(fullAccess: boolean | undefined, run: () => T, additionalRoots?: readonly string[] | null): T {
  return toolAccess.run({ fullAccess: fullAccess === true, additionalRoots: normalizeAdditionalRoots(additionalRoots) }, run)
}

/** Absolute, de-duplicated directory strings; anything else is dropped rather than trusted. */
export function normalizeAdditionalRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const roots = value
    .filter((root): root is string => typeof root === 'string')
    .map(root => root.trim())
    .filter(root => root.length > 0 && !root.includes('\0') && (path.isAbsolute(root) || path.posix.isAbsolute(root)))
  return [...new Set(roots)]
}

/** Parses the persisted `additional_cwds` JSON column. NULL and malformed text mean no extra roots. */
export function parseAdditionalCwds(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeAdditionalRoots(value)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    return normalizeAdditionalRoots(JSON.parse(value))
  } catch {
    return []
  }
}

// Only hits are cached: a root that does not exist yet may be created later.
const canonicalRoots = new Map<string, string>()
const canonicalRoot = (root: string): string | null => {
  const cached = canonicalRoots.get(root)
  if (cached) return cached
  try {
    const resolved = fs.realpathSync.native(root)
    canonicalRoots.set(root, resolved)
    return resolved
  } catch {
    return null
  }
}

/**
 * True when the run may touch `target` although it is outside the cwd: Full access, or the
 * target lies in one of the conversation's additional roots. Roots are compared both as
 * written and canonicalised, so a realpath'd target (e.g. /private/tmp on macOS) still matches.
 */
export function hasToolAccessTo(target: string, posix = false): boolean {
  const access = toolAccess.getStore()
  if (!access) return false
  if (access.fullAccess) return true
  const paths = posix ? path.posix : path
  const resolvedTarget = paths.resolve(target)
  const within = (root: string) => {
    const relative = paths.relative(paths.resolve(root), resolvedTarget)
    return relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
  }
  return access.additionalRoots.some(root => {
    if (within(root)) return true
    if (posix) return false
    const canonical = canonicalRoot(root)
    return canonical != null && canonical !== root && within(canonical)
  })
}
