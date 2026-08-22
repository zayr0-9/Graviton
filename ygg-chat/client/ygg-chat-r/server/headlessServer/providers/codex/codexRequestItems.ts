import { createHash } from 'crypto'
import { buildToolNameMap, sanitizeToolResultContentForModel } from '../toolResultSanitizer.js'
import type { ProviderGenerateInput, ProviderToolDefinition } from '../openRouterProvider.js'
import type { CodexMessage, CodexRequestDiagnostics, CodexRequestParts } from './types.js'

type CodexInputMessage = CodexMessage

const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
const AUTO_COMPACTION_SUMMARY_RESUME_LINE = 'Following is summary of the session, you have to resume the work.'
const GENERATED_IMAGE_PATH_HINT_NOTE = '__generated_image_path_hint__'
const DEFAULT_CODEX_INSTRUCTIONS = 'You are ChatGPT.'

export function toCodexMessages(input: ProviderGenerateInput): CodexMessage[] {
  const messages: CodexMessage[] = []

  if (input.systemPrompt && input.systemPrompt.trim()) {
    messages.push({ role: 'system', content: input.systemPrompt.trim() })
  }

  const toolOutputIds = new Set<string>()
  const toolNameById = buildToolNameMap(input.history || [])

  for (const msg of input.history || []) {
    if (!msg) continue

    if (msg.role === 'system' || msg.role === 'developer') {
      const content = getMessageTextContent(msg).trim()
      if (!content) continue
      if (msg.role === 'system' && !isAutoCompactionSummaryMessage(msg) && !isGeneratedImagePathHintMessage(msg)) continue
      messages.push({ role: msg.role, content })
      continue
    }

    if (msg.role === 'user') {
      const content = getMessageTextContent(msg)
      const contentParts = toUserContentParts(msg)
      if (content.trim() || contentParts.length) messages.push({ role: 'user', content, contentParts })
      continue
    }

    if (msg.role === 'assistant') {
      const toolCalls = parseToolCalls(msg.tool_calls)
      const content = getMessageTextContent(msg)
      if (content.trim() || toolCalls.length > 0) {
        messages.push({ role: 'assistant', content, toolCalls })
      }

      for (const block of parseJsonArray(msg.content_blocks)) {
        if (block?.type !== 'tool_result') continue
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (!callId || toolOutputIds.has(callId)) continue
        toolOutputIds.add(callId)
        messages.push({
          role: 'tool',
          toolCallId: callId,
          name: toolNameById.get(callId) || undefined,
          content: toolOutputContent(block.content, toolNameById.get(callId) || null),
        })
      }
      continue
    }

    if (msg.role === 'tool') {
      const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : typeof msg.toolCallId === 'string' ? msg.toolCallId : ''
      if (!callId || toolOutputIds.has(callId)) continue
      toolOutputIds.add(callId)
      messages.push({
        role: 'tool',
        toolCallId: callId,
        name: typeof msg.name === 'string' ? msg.name : toolNameById.get(callId) || undefined,
        content: toolOutputContent(msg.content, toolNameById.get(callId) || msg.name || null),
      })
    }
  }

  if (!messages.some(message => message.role === 'user') && input.userContent?.trim()) {
    messages.push({ role: 'user', content: input.userContent.trim() })
  }

  return appendImageAttachmentsToLatestUserMessage(messages, input.railwayTurn?.attachmentsBase64 ?? null)
}

export function toCodexRequestParts(messages: CodexInputMessage[], tools: ProviderToolDefinition[]): CodexRequestParts {
  const instructions =
    messages
      .filter(message => (message.role === 'system' || message.role === 'developer') && message.content)
      .map(message => (message.role === 'developer' ? `<developer>\n${message.content}\n</developer>` : message.content))
      .join('\n\n')
      .trim() || DEFAULT_CODEX_INSTRUCTIONS
  const input = messages.flatMap((message, index) => messageToCodexItems(message, index))
  return { instructions, input, tools: [...(tools || []).map(toCodexTool), ...codexHostedTools()] }
}

export function codexHostedTools(): any[] {
  return [{ type: 'web_search' }, { type: 'image_generation' }]
}

function messageToCodexItems(message: CodexInputMessage, index: number): any[] {
  if (message.role === 'system' || message.role === 'developer') return []
  if (message.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.toolCallId || `${message.name || 'tool'}-result-${index}`,
        output: message.content || '',
      },
    ]
  }
  if (message.role === 'user') {
    const content = message.contentParts?.length ? message.contentParts : [{ type: 'input_text', text: message.content || '' }]
    return [{ type: 'message', role: 'user', content }]
  }
  if (message.role === 'assistant') {
    const items: any[] = []
    if (message.content) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
    for (const toolCall of message.toolCalls || []) items.push(toolCallToCodexItem(toolCall))
    return items
  }
  return []
}

function toolCallToCodexItem(toolCall: NonNullable<CodexMessage['toolCalls']>[number]): any {
  return {
    type: 'function_call',
    name: toolCall.toolName,
    arguments: stringifyArgs(toolCall.args),
    call_id: toolCall.id || `call_${toolCall.toolName}`,
  }
}

function toCodexTool(tool: ProviderToolDefinition): any {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    strict: false,
    parameters: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: true },
  }
}

export function buildCodexRequestDiagnostics(params: {
  promptCacheKey: string
  requestId: string
  instructions?: string
  input: any[]
  tools: any[]
}): CodexRequestDiagnostics {
  return {
    promptCacheKey: params.promptCacheKey,
    requestId: params.requestId,
    inputItems: params.input.length,
    instructionsHash: stableHash(params.instructions || ''),
    toolsHash: stableHash(params.tools),
    firstItemsHash: stableHash(params.input.slice(0, 8)),
    fullInputHash: stableHash(params.input),
    messageShape: params.input.map(item => (item?.type === 'message' ? `${item.type}:${item.role || ''}` : item?.type || typeof item)),
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex').slice(0, 16)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: any): any {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value)
    .sort()
    .reduce((acc: Record<string, any>, key) => {
      acc[key] = sortJson(value[key])
      return acc
    }, {})
}

function getMessageTextContent(msg: any): string {
  const content = typeof msg?.content === 'string' ? msg.content : asText(msg?.content)
  const plainText = typeof msg?.content_plain_text === 'string' ? msg.content_plain_text : ''
  return content || plainText
}

function asText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (typeof item?.text === 'string') return item.text
        if (typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function isAutoCompactionSummaryMessage(msg: any): boolean {
  if (!msg) return false
  if (msg.note === AUTO_COMPACTION_NOTE) return true
  const text = getMessageTextContent(msg).trim()
  return (msg.role === 'system' || msg.role === 'developer') && text.startsWith(AUTO_COMPACTION_SUMMARY_RESUME_LINE)
}

function isGeneratedImagePathHintMessage(msg: any): boolean {
  return Boolean(msg && msg.note === GENERATED_IMAGE_PATH_HINT_NOTE)
}

function parseJsonArray(value: any): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function parseToolCalls(value: any): NonNullable<CodexMessage['toolCalls']> {
  return parseJsonArray(value)
    .map(raw => {
      const id = typeof raw?.id === 'string' ? raw.id : typeof raw?.call_id === 'string' ? raw.call_id : ''
      const toolName = typeof raw?.name === 'string' ? raw.name : typeof raw?.function?.name === 'string' ? raw.function.name : ''
      if (!id || !toolName) return null
      return { id, toolName, args: raw.arguments ?? raw.args ?? raw.input ?? {} }
    })
    .filter(Boolean) as NonNullable<CodexMessage['toolCalls']>
}

function stringifyArgs(value: any): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function toolOutputContent(content: any, toolName: string | null): string {
  const sanitized = sanitizeToolResultContentForModel(content, toolName)
  return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized ?? null)
}

function toUserContentParts(msg: any): any[] {
  const parts: any[] = []
  const text = getMessageTextContent(msg)
  if (text.trim()) parts.push({ type: 'input_text', text })
  const existingImageUrls = new Set<string>()
  for (const url of collectUserMessageImageUrls(msg)) {
    if (existingImageUrls.has(url)) continue
    existingImageUrls.add(url)
    parts.push({ type: 'input_image', image_url: url })
  }
  return parts
}

function collectUserMessageImageUrls(msg: any): string[] {
  const urls: string[] = []
  for (const block of parseJsonArray(msg?.content_blocks)) {
    const url = normalizeAttachmentImageUrl(block)
    if (url) urls.push(url)
  }
  for (const attachment of parseJsonArray(msg?.attachments)) {
    const url = normalizeAttachmentImageUrl(attachment)
    if (url) urls.push(url)
  }
  return urls
}

function appendImageAttachmentsToLatestUserMessage(messages: CodexMessage[], attachmentsBase64?: any[] | null): CodexMessage[] {
  if (!Array.isArray(attachmentsBase64) || attachmentsBase64.length === 0) return messages
  const imageParts = attachmentsBase64
    .map(attachment => normalizeAttachmentImageUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map(url => ({ type: 'input_image', image_url: url }))
  if (imageParts.length === 0) return messages

  const result = [...messages]
  let latestUserIndex = -1
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]?.role === 'user') {
      latestUserIndex = i
      break
    }
  }
  if (latestUserIndex < 0) {
    result.push({ role: 'user', contentParts: imageParts })
    return result
  }
  const target = { ...result[latestUserIndex] }
  const existing = target.contentParts?.length ? [...target.contentParts] : target.content ? [{ type: 'input_text', text: target.content }] : []
  const existingUrls = new Set(existing.filter(part => part?.type === 'input_image').map(part => part.image_url))
  for (const imagePart of imageParts) {
    if (!existingUrls.has(imagePart.image_url)) existing.push(imagePart)
  }
  target.contentParts = existing
  result[latestUserIndex] = target
  return result
}

function normalizeAttachmentImageUrl(attachment: any): string | null {
  if (!attachment) return null
  if (typeof attachment === 'string') {
    const trimmed = attachment.trim()
    return /^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed) ? trimmed : null
  }
  const candidate = attachment.dataUrl || attachment.dataURL || attachment.url || attachment.image_url || attachment.imageUrl || null
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  return /^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed) ? trimmed : null
}
