import { describe, expect, it } from 'vitest'
import { toMcpExecutionResult } from '../../mcp/mcpToolResult.js'

describe('toMcpExecutionResult', () => {
  it('preserves the complete CallToolResult for the MCP App view', () => {
    const callResult = {
      content: [{ type: 'text', text: 'Summary for the model' }],
      structuredContent: { rows: [{ fund: 'Fund A', commitment: 42 }] },
      _meta: { renderedAt: '2026-07-17T00:00:00Z' },
    }

    const executionResult = toMcpExecutionResult(callResult)

    expect(executionResult.persistedContent).toEqual(callResult)
    expect(executionResult.displayContent).toEqual(callResult)
    expect(executionResult.modelContent).toEqual(callResult.content)
    expect(executionResult.text).toBe('Summary for the model')
  })

  it('keeps MCP isError semantics while retaining structured result data', () => {
    const callResult = {
      content: [{ type: 'text', text: 'Request failed' }],
      structuredContent: { retryable: true },
      isError: true,
    }

    const executionResult = toMcpExecutionResult(callResult)

    expect(executionResult.success).toBe(false)
    expect(executionResult.error).toBe('Request failed')
    expect(executionResult.persistedContent).toEqual(callResult)
  })
})
