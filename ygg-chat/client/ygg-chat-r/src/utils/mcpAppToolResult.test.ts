import { describe, expect, it } from 'vitest'
import { normalizeMcpAppToolResult } from './mcpAppToolResult'

describe('normalizeMcpAppToolResult', () => {
  it('restores the full persisted MCP CallToolResult', () => {
    const result = {
      content: JSON.stringify({
        content: [{ type: 'text', text: 'summary' }],
        structuredContent: { subscriptions: [{ id: 'sub-1' }] },
        _meta: { page: 1 },
      }),
      is_error: false,
    }

    expect(normalizeMcpAppToolResult(result)).toEqual({
      content: [{ type: 'text', text: 'summary' }],
      structuredContent: { subscriptions: [{ id: 'sub-1' }] },
      _meta: { page: 1 },
    })
  })

  it('keeps legacy content arrays compatible', () => {
    expect(normalizeMcpAppToolResult({ content: [{ type: 'text', text: 'legacy' }] })).toEqual({
      content: [{ type: 'text', text: 'legacy' }],
    })
  })
})
