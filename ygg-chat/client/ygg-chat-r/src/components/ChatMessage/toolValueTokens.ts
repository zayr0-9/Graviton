/**
 * Splits the compact JSON that `stringifyToolValue` produces for objects and arrays into
 * colourable tokens. The token texts concatenate back to the input exactly, so a tool field keeps
 * the same characters (and the same copy result) it had as one plain span.
 */

export type ToolValueTokenKind = 'key' | 'string' | 'literal' | 'punctuation'

export interface ToolValueToken {
  kind: ToolValueTokenKind
  text: string
}

export interface ToolValueTokenLimits {
  /** Above this many tokens the value renders as one plain span. */
  tokenLimit: number
  /** Above this many characters the value is not tokenised at all. */
  charLimit: number
}

/** Bounds the spans one field can add to the DOM; large payloads stay one text node. */
export const TOOL_VALUE_TOKEN_LIMITS: ToolValueTokenLimits = { tokenLimit: 400, charLimit: 2000 }

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WHITESPACE = /\s/

/**
 * Tokenises JSON text. Returns null for text that is not JSON (a `[object Object]` fallback, a
 * cycle error message) or that exceeds the limits, and the caller renders the plain text instead.
 * Adjacent punctuation (including any whitespace) merges into one token.
 */
export const tokenizeJson = (json: string, limits: ToolValueTokenLimits = TOOL_VALUE_TOKEN_LIMITS): ToolValueToken[] | null => {
  if (json.length > limits.charLimit) return null
  const tokens: ToolValueToken[] = []
  const push = (kind: ToolValueTokenKind, text: string): boolean => {
    const last = tokens[tokens.length - 1]
    if (kind === 'punctuation' && last?.kind === 'punctuation') {
      last.text += text
      return true
    }
    if (tokens.length >= limits.tokenLimit) return false
    tokens.push({ kind, text })
    return true
  }

  const length = json.length
  let index = 0
  while (index < length) {
    const ch = json[index]
    if (ch === '"') {
      let end = index + 1
      while (end < length && json[end] !== '"') {
        if (json[end] === '\\') end += 1
        end += 1
      }
      if (end >= length) return null
      let lookahead = end + 1
      while (lookahead < length && WHITESPACE.test(json[lookahead])) lookahead += 1
      if (!push(json[lookahead] === ':' ? 'key' : 'string', json.slice(index, end + 1))) return null
      index = end + 1
      continue
    }
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',' || WHITESPACE.test(ch)) {
      if (!push('punctuation', ch)) return null
      index += 1
      continue
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER_PATTERN.lastIndex = index
      const match = NUMBER_PATTERN.exec(json)
      if (!match) return null
      if (!push('literal', match[0])) return null
      index += match[0].length
      continue
    }
    const literal = json.startsWith('true', index) ? 'true' : json.startsWith('false', index) ? 'false' : json.startsWith('null', index) ? 'null' : null
    if (!literal || !push('literal', literal)) return null
    index += literal.length
  }
  return tokens
}
