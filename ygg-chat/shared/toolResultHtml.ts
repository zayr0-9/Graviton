export const extractHtmlFromToolResult = (content: unknown): { html: string; toolName?: string | null } | null => {
  let resolved = content
  if (typeof resolved === 'string') {
    if (!resolved.trimStart().startsWith('{')) return null
    try {
      resolved = JSON.parse(resolved)
    } catch {
      return null
    }
  }
  if (!resolved || typeof resolved !== 'object') return null

  const result = resolved as Record<string, unknown>
  const html = typeof result.html === 'string'
    ? result.html
    : result.type === 'text/html' && typeof result.content === 'string' ? result.content : null
  if (!html?.trim()) return null
  const toolName = result.toolName ?? result.tool_name
  return { html, toolName: typeof toolName === 'string' ? toolName : null }
}

/** Compact transcript rows carry the layout hint without shipping the HTML body. */
export const hasHtmlToolResult = (result: { content?: unknown; html_omitted?: boolean }): boolean =>
  result.html_omitted === true || extractHtmlFromToolResult(result.content) !== null
