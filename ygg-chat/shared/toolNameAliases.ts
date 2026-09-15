/**
 * Claude Code tool name → Graviton tool name aliases (docs §11.3 decision 11).
 *
 * Applied when parsing `tools`, `disallowedTools`, `allowed-tools`, `disallowed-tools`
 * and hook `matcher` values read from repo-authored markdown, so a file written for
 * Claude Code keeps working. Unknown names pass through unchanged with a debug line.
 */

export const CLAUDE_CODE_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Read: ['read_file', 'read_files', 'read_file_continuation'],
  Grep: ['ripgrep'],
  Glob: ['glob'],
  Bash: ['bash'],
  Edit: ['edit_file', 'multi_edit'],
  MultiEdit: ['multi_edit'],
  Write: ['create_file'],
  Agent: ['subagent'],
  Task: ['subagent'],
  Skill: ['skill_manager'],
  WebFetch: ['browse_web'],
  WebSearch: ['brave_search'],
  TodoWrite: ['todo_md'],
  LS: ['directory'],
})

/** Strip a Claude Code permission-rule argument: `Bash(git *)` → `Bash`. */
export function stripToolRuleArgument(value: string): string {
  const trimmed = value.trim()
  const paren = trimmed.indexOf('(')
  return paren > 0 ? trimmed.slice(0, paren).trim() : trimmed
}

export interface ResolveToolAliasesResult {
  names: string[]
  unknown: string[]
}

/**
 * Expand a list of Claude Code or Graviton tool names into Graviton tool names.
 * `known` is the set of tool names the host can run; a name that is neither an alias
 * nor a known Graviton tool is reported in `unknown` and kept as-is.
 */
export function resolveToolAliases(values: readonly string[], known?: ReadonlySet<string>): ResolveToolAliasesResult {
  const names: string[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    names.push(name)
  }
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const base = stripToolRuleArgument(raw)
    if (!base) continue
    if (base === '*') {
      push('*')
      continue
    }
    const aliases = CLAUDE_CODE_TOOL_ALIASES[base]
    if (aliases) {
      aliases.forEach(push)
      continue
    }
    if (base.startsWith('mcp__')) {
      push(base)
      continue
    }
    if (!known || known.has(base)) {
      push(base)
      continue
    }
    unknown.push(base)
    push(base)
  }
  return { names, unknown }
}

/** Accept a YAML list or a comma/space separated string (docs §1 "Lists"). */
export function parseToolNameList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  // Split on commas or whitespace, but keep `Bash(git *)` style rules intact.
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      if (current.trim()) out.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) out.push(current.trim())
  return out
}
