export interface McpCallToolResultLike {
  content?: unknown[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Preserve the complete MCP CallToolResult for the host UI while limiting the
 * provider continuation to the standard model-visible content blocks.
 */
export function toMcpExecutionResult(result: McpCallToolResultLike): Record<string, unknown> {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .filter((item): item is { type: 'text'; text: string } =>
      Boolean(item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string')
    )
    .map(item => item.text)
    .join('\n')

  return {
    success: !result.isError,
    content,
    text,
    error: result.isError ? text || 'MCP tool call failed' : undefined,
    displayContent: result,
    persistedContent: result,
    modelContent: content,
  }
}
