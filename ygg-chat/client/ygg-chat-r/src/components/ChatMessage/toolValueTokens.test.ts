import { describe, expect, it } from 'vitest'
import { tokenizeJson, TOOL_VALUE_TOKEN_LIMITS } from './toolValueTokens'

const sample = {
  tool: 'read_file',
  args: { path: 'a/b.ts', lines: [1, 2.5, -3e2], ok: true, none: null, text: 'say "hi"\n', empty: {} },
  n: 0,
}

describe('tokenizeJson', () => {
  it('concatenates back to the input text', () => {
    const json = JSON.stringify(sample)
    const tokens = tokenizeJson(json)!
    expect(tokens.map(token => token.text).join('')).toBe(json)
  })

  it('tells keys, strings, literals and punctuation apart', () => {
    const tokens = tokenizeJson(JSON.stringify(sample))!
    const texts = (kind: string) => tokens.filter(token => token.kind === kind).map(token => token.text)
    expect(texts('key')).toEqual(['"tool"', '"args"', '"path"', '"lines"', '"ok"', '"none"', '"text"', '"empty"', '"n"'])
    expect(texts('string')).toEqual(['"read_file"', '"a/b.ts"', '"say \\"hi\\"\\n"'])
    expect(texts('literal')).toEqual(['1', '2.5', '-300', 'true', 'null', '0'])
  })

  it('merges adjacent punctuation into one token', () => {
    expect(tokenizeJson('{"a":[]}')).toEqual([
      { kind: 'punctuation', text: '{' },
      { kind: 'key', text: '"a"' },
      { kind: 'punctuation', text: ':[]}' },
    ])
  })

  it('tolerates whitespace and still detects keys across it', () => {
    const json = '{ "a" : "b" }'
    const tokens = tokenizeJson(json)!
    expect(tokens.map(token => token.text).join('')).toBe(json)
    expect(tokens.find(token => token.text === '"a"')?.kind).toBe('key')
    expect(tokens.find(token => token.text === '"b"')?.kind).toBe('string')
  })

  it('treats a top-level string, number or literal as a single token', () => {
    expect(tokenizeJson('"x"')).toEqual([{ kind: 'string', text: '"x"' }])
    expect(tokenizeJson('42')).toEqual([{ kind: 'literal', text: '42' }])
    expect(tokenizeJson('false')).toEqual([{ kind: 'literal', text: 'false' }])
  })

  it.each(['[object Object]', 'hello', '{"a":tru}', '{"a":"unterminated', '{"a":-}', 'undefined'])('returns null for non-JSON %j', input => {
    expect(tokenizeJson(input)).toBeNull()
  })

  it('returns null above the token limit', () => {
    // `{`, "a", `:`, 1, `,`, "b", `:`, 2, `}` is nine tokens.
    expect(tokenizeJson('{"a":1,"b":2}', { ...TOOL_VALUE_TOKEN_LIMITS, tokenLimit: 8 })).toBeNull()
    expect(tokenizeJson('{"a":1,"b":2}', { ...TOOL_VALUE_TOKEN_LIMITS, tokenLimit: 9 })).toHaveLength(9)
  })

  it('returns null above the character limit', () => {
    const json = JSON.stringify({ items: Array.from({ length: 1000 }, (_, i) => i) })
    expect(json.length).toBeGreaterThan(TOOL_VALUE_TOKEN_LIMITS.charLimit)
    expect(tokenizeJson(json)).toBeNull()
    expect(tokenizeJson(json, { tokenLimit: 10_000, charLimit: json.length })).not.toBeNull()
  })
})
