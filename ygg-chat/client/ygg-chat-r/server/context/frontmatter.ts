// server/context/frontmatter.ts
// Shared frontmatter envelope for every auto-loaded markdown file
// (docs/claude_code_context_loading_rules.md §1).

import yaml from 'yaml'

export interface ParsedFrontmatter {
  /** Parsed YAML object, or an empty object when the file has no frontmatter. */
  data: Record<string, unknown>
  /** Everything after the closing `---`, or the whole file without frontmatter. */
  body: string
  /** True when a `---` block was found on line 1 and parsed as a YAML object. */
  hasFrontmatter: boolean
  /** YAML parse error message, when the block existed but failed to parse. */
  error: string | null
}

const OPENING = /^---[ \t]*\r?\n/
const CLOSING = /\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * §1: the opening `---` must be on line 1; otherwise the file has no frontmatter
 * and the whole file is body. A YAML parse error keeps the body and reports the
 * error so the caller can decide (agents skip the file, rules drop the frontmatter).
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const source = content.startsWith('﻿') ? content.slice(1) : content
  const open = source.match(OPENING)
  if (!open) return { data: {}, body: source, hasFrontmatter: false, error: null }

  const afterOpen = source.slice(open[0].length)
  const close = afterOpen.match(CLOSING)
  if (!close || close.index === undefined) return { data: {}, body: source, hasFrontmatter: false, error: null }

  const yamlText = afterOpen.slice(0, close.index)
  const body = afterOpen.slice(close.index + close[0].length)
  try {
    const parsed = yaml.parse(yamlText)
    if (parsed === null || parsed === undefined) return { data: {}, body, hasFrontmatter: true, error: null }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, body, hasFrontmatter: false, error: 'frontmatter must be a YAML mapping' }
    }
    return { data: parsed as Record<string, unknown>, body, hasFrontmatter: true, error: null }
  } catch (error) {
    return { data: {}, body, hasFrontmatter: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** §1 booleans: true/false/yes/no/on/off/1/0 in any case. Anything else → undefined. */
export function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  return undefined
}

/** §1 lists: a YAML list or a comma- or space-separated string. */
export function parseFrontmatterList(value: unknown, separators: 'comma' | 'comma-space' = 'comma-space'): string[] {
  if (Array.isArray(value)) {
    return value.map(entry => (typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim())).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  const pattern = separators === 'comma' ? /,/ : /[,\s]+/
  return value
    .split(pattern)
    .map(part => part.trim())
    .filter(Boolean)
}

export function parseFrontmatterString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * §1 "HTML comments": strip block-level `<!-- ... -->` outside fenced code blocks.
 * Comments inside ``` fences stay. A comment that spans lines is removed whole.
 */
export function stripHtmlComments(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const out: string[] = []
  let inFence = false
  let fenceMarker = ''
  let inComment = false

  for (const line of lines) {
    if (!inComment) {
      const fence = line.match(/^\s*(`{3,}|~{3,})/)
      if (fence) {
        if (!inFence) {
          inFence = true
          fenceMarker = fence[1][0]
        } else if (fence[1][0] === fenceMarker) {
          inFence = false
          fenceMarker = ''
        }
        out.push(line)
        continue
      }
      if (inFence) {
        out.push(line)
        continue
      }
    }

    let rest = line
    let kept = ''
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->')
        if (end === -1) {
          rest = ''
          break
        }
        rest = rest.slice(end + 3)
        inComment = false
        continue
      }
      const start = rest.indexOf('<!--')
      if (start === -1) {
        kept += rest
        rest = ''
        break
      }
      kept += rest.slice(0, start)
      rest = rest.slice(start + 4)
      inComment = true
    }
    // Drop lines that became empty only because a comment was removed.
    if (kept.trim().length === 0 && kept !== line) continue
    out.push(kept)
  }
  return out.join('\n')
}
