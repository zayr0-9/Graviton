export type McpAppToolResultEnvelope = {
  content: unknown
  is_error?: boolean
}

/** Restore a persisted MCP CallToolResult and keep structuredContent/_meta intact. */
export const normalizeMcpAppToolResult = (result?: McpAppToolResultEnvelope | null) => {
  if (!result) return null
  const payload: Record<string, unknown> = {}
  if (result.is_error) payload.isError = true
  let raw = result.content

  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return { content: [{ type: 'text', text: raw }], ...payload }
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as any).content)) {
    return { ...(raw as Record<string, unknown>), ...payload }
  }
  if (Array.isArray(raw)) {
    return { content: raw, ...payload }
  }
  if (raw && typeof raw === 'object') {
    return { content: [], structuredContent: raw, ...payload }
  }
  return { content: [{ type: 'text', text: String(raw ?? '') }], ...payload }
}
