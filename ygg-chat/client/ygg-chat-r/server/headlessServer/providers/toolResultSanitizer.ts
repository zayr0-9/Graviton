function looksLikeHtmlString(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  return /^<(?:!doctype\s+html|html|head|body|div|span|section|article|main|p|h[1-6]|ul|ol|li|table|tr|td|th|script|style|svg|canvas|iframe)\b/i.test(
    trimmed
  )
}

function parseJson(raw: string): any | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function extractHtmlPayload(content: any): { html: string; toolName?: string | null } | null {
  let resolved = content

  if (typeof resolved === 'string') {
    const trimmed = resolved.trim()
    if (!trimmed) return null
    if (looksLikeHtmlString(trimmed)) {
      return { html: trimmed }
    }

    const parsed = parseJson(trimmed)
    if (parsed == null) {
      return null
    }
    resolved = parsed
  }

  if (typeof resolved === 'string') {
    if (looksLikeHtmlString(resolved)) {
      return { html: resolved }
    }
    return null
  }

  if (typeof resolved === 'object' && resolved !== null) {
    if (typeof (resolved as any).html === 'string') {
      return {
        html: (resolved as any).html,
        toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
      }
    }
    if ((resolved as any).type === 'text/html' && typeof (resolved as any).content === 'string') {
      return {
        html: (resolved as any).content,
        toolName: (resolved as any).toolName ?? (resolved as any).tool_name ?? null,
      }
    }
  }

  return null
}

export function getToolCallName(tc: any): string {
  if (!tc) return ''
  if (typeof tc.name === 'string') return tc.name
  if (typeof tc?.function?.name === 'string') return tc.function.name
  return ''
}

function parseToolCalls(value: any): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const parsed = parseJson(value)
    return Array.isArray(parsed) ? parsed : []
  }
  return []
}

function parseBlocks(value: any): any[] {
  const parsed = typeof value === 'string' ? parseJson(value) : value
  return Array.isArray(parsed) ? parsed : []
}

/**
 * The tool calls a persisted message made. `content_blocks` is canonical: its `tool_use`
 * blocks carry id, name and input. The legacy `tool_calls` column (no longer written) is
 * read only for rows without `tool_use` blocks: pre-block rows, older OpenAI rows whose
 * blocks hold only `responses_output_items`, and caller-supplied history. Legacy entries
 * are returned as stored, so callers keep their own field normalisation.
 */
export function messageToolCalls(msg: any): any[] {
  const toolUses = parseBlocks(msg?.content_blocks)
    .filter(block => block?.type === 'tool_use' && typeof block.id === 'string' && block.id)
  if (toolUses.length === 0) return parseToolCalls(msg?.tool_calls)
  return toolUses.map(block => ({ id: block.id, name: typeof block.name === 'string' ? block.name : '', arguments: block.input ?? {} }))
}

export function buildToolNameMap(history: any[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of history || []) {
    if (!msg || msg.role !== 'assistant') continue
    const toolCalls = messageToolCalls(msg)
    for (const tc of toolCalls) {
      const id = tc?.id
      const name = getToolCallName(tc)
      if (typeof id === 'string' && id && name) {
        map.set(id, name)
      }
    }
  }
  return map
}

function extractViewImagePayload(content: any): { imageUrl: string; detail?: 'high' | 'original' } | null {
  let resolved = content
  if (typeof resolved === 'string') {
    const parsed = parseJson(resolved.trim())
    if (parsed == null) return null
    resolved = parsed
  }

  if (!resolved || typeof resolved !== 'object') return null
  if (Array.isArray(resolved)) {
    const imageItem = resolved.find(
      (item: any) => item?.type === 'input_image' && typeof item?.image_url === 'string' && /^data:image\//i.test(item.image_url)
    )
    if (!imageItem) return null
    return { imageUrl: imageItem.image_url, detail: imageItem.detail === 'original' ? 'original' : 'high' }
  }

  const directImageUrl = typeof resolved.image_url === 'string' ? resolved.image_url : null
  const contentItems = Array.isArray(resolved.content) ? resolved.content : []
  const imageItem = contentItems.find(
    (item: any) => item?.type === 'input_image' && typeof item?.image_url === 'string'
  )

  const imageUrl = directImageUrl || imageItem?.image_url || null
  if (!imageUrl || !/^data:image\//i.test(imageUrl)) return null

  const rawDetail = typeof resolved.detail === 'string' ? resolved.detail : imageItem?.detail
  const detail = rawDetail === 'original' ? 'original' : 'high'
  return { imageUrl, detail }
}

function extractPlanModelContent(content: any, toolName?: string | null): string | null {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : ''
  if (normalizedToolName !== 'plan_md') return null

  let resolved = content
  if (typeof resolved === 'string') {
    const parsed = parseJson(resolved.trim())
    if (parsed == null) return null
    resolved = parsed
  }

  if (!resolved || typeof resolved !== 'object') return null
  const modelContent = (resolved as any).modelContent
  return typeof modelContent === 'string' && modelContent.trim() ? modelContent : null
}

export function sanitizeToolResultContentForModel(content: any, toolName?: string | null): any {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : ''

  if (Array.isArray(content)) {
    const imageParts = content.filter(
      item => item?.type === 'input_image' && typeof item?.image_url === 'string' && /^data:image\//i.test(item.image_url)
    )
    if (normalizedToolName === 'view_image' && imageParts.length > 0) return imageParts
  }
  const planModelContent = extractPlanModelContent(content, normalizedToolName)
  if (planModelContent) return planModelContent

  if (normalizedToolName === 'view_image') {
    const viewImage = extractViewImagePayload(content)
    if (viewImage) {
      return [{ type: 'input_image', image_url: viewImage.imageUrl, detail: viewImage.detail }]
    }
  }

  const htmlPayload = extractHtmlPayload(content)
  if (htmlPayload?.html) {
    const resolvedName = toolName ?? htmlPayload.toolName ?? null
    const resolved = typeof content === 'string' ? parseJson(content) : content
    if (normalizedToolName === 'html_renderer' && typeof resolved?.documentId === 'string') {
      return JSON.stringify({ success: true, displayed: true, documentId: resolved.documentId })
    }
    return `displaying ${resolvedName || 'custom tool'} ui now`
  }
  return content
}
