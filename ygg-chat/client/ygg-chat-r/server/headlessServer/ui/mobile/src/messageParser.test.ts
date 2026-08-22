import { describe, expect, it } from 'vitest'
import { extractHtmlFromToolResult } from './messageParser'

describe('extractHtmlFromToolResult', () => {
  it('extracts html payload from embedded html field', () => {
    const result = extractHtmlFromToolResult(
      JSON.stringify({
        success: true,
        html: '<html><body>hello</body></html>',
        toolName: 'demo_tool',
      })
    )

    expect(result).toBeTruthy()
    expect(result?.html).toContain('hello')
    expect(result?.toolName).toBe('demo_tool')
  })

  it('extracts html payload from text/html result shape', () => {
    const result = extractHtmlFromToolResult({
      type: 'text/html',
      content: '<html><body>demo</body></html>',
      tool_name: 'legacy_demo',
    })

    expect(result?.html).toContain('demo')
    expect(result?.toolName).toBe('legacy_demo')
  })
})
