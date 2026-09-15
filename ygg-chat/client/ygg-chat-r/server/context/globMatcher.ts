// server/context/globMatcher.ts
// Glob semantics for rule / skill `paths` (docs §3.3):
//   **      any depth of directories, including zero
//   *       any characters inside one path segment
//   {a,b}   brace expansion; each group multiplies the pattern count
//   [abc]   bracket expression; an unreadable `[` makes the pattern invalid
//   Patterns are anchored at the project root: `*.md` matches only root-level files.
// Budget per `paths` list: 1,000 expanded patterns and 4 MiB of pattern text.
// A pattern that would exceed the budget is used unexpanded (its braces match nothing).

export const GLOB_EXPANSION_PATTERN_BUDGET = 1000
export const GLOB_EXPANSION_BYTE_BUDGET = 4 * 1024 * 1024

export interface CompiledGlobList {
  /** One RegExp per valid expanded pattern. */
  matchers: RegExp[]
  /** Patterns that could not be compiled (invalid bracket expression). */
  invalid: string[]
  /** Patterns that exceeded the brace budget and were used unexpanded. */
  unexpanded: string[]
}

const OPEN_BRACE_PLACEHOLDER = '\uE000'
const CLOSE_BRACE_PLACEHOLDER = '\uE001'

/** Expand one level of `{a,b}` groups recursively. Returns [pattern] when no braces. */
export function expandBraces(pattern: string): string[] {
  const open = findTopLevelBrace(pattern)
  if (open === null) return [pattern]
  const { start, end } = open
  const prefix = pattern.slice(0, start)
  const suffix = pattern.slice(end + 1)
  const inner = pattern.slice(start + 1, end)
  const alternatives = splitTopLevelCommas(inner)
  if (alternatives.length < 2) {
    // `{single}` is not a brace expansion; protect the braces with private-use placeholders.
    return expandBraces(`${prefix}${OPEN_BRACE_PLACEHOLDER}${inner}${CLOSE_BRACE_PLACEHOLDER}${suffix}`).map(p =>
      p.split(OPEN_BRACE_PLACEHOLDER).join('{').split(CLOSE_BRACE_PLACEHOLDER).join('}')
    )
  }
  const results: string[] = []
  for (const alternative of alternatives) {
    for (const expanded of expandBraces(`${prefix}${alternative}${suffix}`)) results.push(expanded)
  }
  return results
}

function findTopLevelBrace(pattern: string): { start: number; end: number } | null {
  let depth = 0
  let start = -1
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (char === '}') {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) return { start, end: i }
    }
  }
  return null
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '\\') {
      current += char + (value[i + 1] ?? '')
      i += 1
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/**
 * Compile a single (already brace-expanded) glob to a RegExp anchored at the root.
 * Returns null when a `[` cannot be read as a bracket expression.
 */
export function compileGlob(pattern: string): RegExp | null {
  let normalized = pattern.replace(/\\/g, (match, offset, source) => {
    // Keep escapes of glob metacharacters; convert Windows separators otherwise.
    const next = source[offset + 1]
    return next && '*?[]{}\\'.includes(next) ? match : '/'
  })
  normalized = normalized.replace(/^\.\//, '').replace(/^\/+/, '')
  let regex = '^'
  let i = 0
  while (i < normalized.length) {
    const char = normalized[i]
    if (char === '\\') {
      const next = normalized[i + 1]
      if (next === undefined) return null
      regex += escapeRegex(next)
      i += 2
      continue
    }
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        // `**` — consume the following slash so `**/x` also matches `x`.
        let j = i + 2
        if (normalized[j] === '/') {
          regex += '(?:.*/)?'
          j += 1
        } else if (i === 0 || normalized[i - 1] === '/') {
          regex += '.*'
        } else {
          regex += '[^/]*'
        }
        i = j
        continue
      }
      regex += '[^/]*'
      i += 1
      continue
    }
    if (char === '?') {
      regex += '[^/]'
      i += 1
      continue
    }
    if (char === '[') {
      const close = findBracketClose(normalized, i)
      if (close === -1) return null
      let body = normalized.slice(i + 1, close)
      let negate = false
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = true
        body = body.slice(1)
      }
      if (!body) return null
      const escapedBody = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
      regex += `[${negate ? '^' : ''}${escapedBody}]`
      i = close + 1
      continue
    }
    regex += escapeRegex(char)
    i += 1
  }
  regex += '$'
  try {
    return new RegExp(regex)
  } catch {
    return null
  }
}

function findBracketClose(pattern: string, openIndex: number): number {
  // POSIX rule: a `]` right after `[` or `[!` is literal.
  let i = openIndex + 1
  if (pattern[i] === '!' || pattern[i] === '^') i += 1
  if (pattern[i] === ']') i += 1
  for (; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i += 1
      continue
    }
    if (pattern[i] === ']') return i
    if (pattern[i] === '/') return -1
  }
  return -1
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Compile a whole `paths` list under the shared brace budget. */
export function compileGlobList(patterns: readonly string[]): CompiledGlobList {
  const matchers: RegExp[] = []
  const invalid: string[] = []
  const unexpanded: string[] = []
  let expandedCount = 0
  let expandedBytes = 0

  for (const raw of patterns) {
    const pattern = raw.trim()
    if (!pattern) continue
    const hasBraces = findTopLevelBrace(pattern) !== null
    let candidates: string[]
    if (!hasBraces) {
      candidates = [pattern]
    } else {
      const expanded = expandBraces(pattern)
      const bytes = expanded.reduce((total, p) => total + Buffer.byteLength(p, 'utf8'), 0)
      if (expandedCount + expanded.length > GLOB_EXPANSION_PATTERN_BUDGET || expandedBytes + bytes > GLOB_EXPANSION_BYTE_BUDGET) {
        unexpanded.push(pattern)
        candidates = [pattern]
      } else {
        expandedCount += expanded.length
        expandedBytes += bytes
        candidates = expanded
      }
    }
    for (const candidate of candidates) {
      const compiled = compileGlob(candidate)
      if (compiled) matchers.push(compiled)
      else invalid.push(candidate)
    }
  }
  return { matchers, invalid, unexpanded }
}

/** Normalise a root-relative path for matching: forward slashes, no leading `./`. */
export function toGlobRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function globListMatches(compiled: CompiledGlobList, relativePath: string): boolean {
  const candidate = toGlobRelativePath(relativePath)
  return compiled.matchers.some(matcher => matcher.test(candidate))
}

/**
 * `claudeMdExcludes`-style matching against ABSOLUTE paths (docs §2.5). Patterns are
 * matched against the full path with forward slashes. A pattern without a leading
 * slash or a leading double-star is tried as a suffix, so both a bare
 * `CLAUDE.local.md` pattern and an absolute directory pattern work.
 */
export function absolutePathMatchesAny(patterns: readonly string[], absolutePath: string): boolean {
  if (patterns.length === 0) return false
  const normalized = absolutePath.replace(/\\/g, '/')
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (!pattern) continue
    const expanded = expandBraces(pattern)
    for (const candidate of expanded) {
      const anchored = candidate.startsWith('/') || candidate.startsWith('**') ? candidate : `**/${candidate}`
      const compiled = compileGlob(anchored.startsWith('/') ? anchored.slice(1) : anchored)
      if (compiled && compiled.test(normalized.replace(/^\/+/, ''))) return true
    }
  }
  return false
}
