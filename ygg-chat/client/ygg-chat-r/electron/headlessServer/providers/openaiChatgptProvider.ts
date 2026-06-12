import path from 'path'
import WebSocket from 'ws'
import {
  JWT_CLAIM_PATH,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_URL,
} from '../../openaiChatgptOAuth.js'
import type { ProviderTokenStore } from './tokenStore.js'
import { CodexResponsesProvider, toCodexMessages } from './codex/index.js'
import { buildToolNameMap, sanitizeToolResultContentForModel } from './toolResultSanitizer.js'
import type {
  HeadlessProvider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderStreamEventHandler,
  ProviderToolCall,
  ProviderToolDefinition,
} from './openRouterProvider.js'

interface OpenAiChatgptProviderDeps {
  tokenStore?: ProviderTokenStore
}

interface ResolvedAuth {
  accessToken: string
  accountId: string
}

interface RefreshedTokenPayload {
  accessToken: string
  refreshToken: string
  expiresAtIso: string
  accountId: string
}

function normalizeModel(model: string): string {
  const m = (model || '').toLowerCase().replace(/\s+/g, '-')

  if (m.includes('gpt-5.5-pro')) return 'gpt-5.5-pro'
  if (m.includes('gpt-5.5')) return 'gpt-5.5'
  if (m.includes('gpt-5.4-mini')) return 'gpt-5.4-mini'
  if (m.includes('gpt-5.4-pro')) return 'gpt-5.4-pro'
  if (m.includes('gpt-5.4')) return 'gpt-5.4'
  if (m.includes('gpt-5.3-codex')) return 'gpt-5.3-codex'

  // Retired ChatGPT Codex models: route stale saved/default selections to an available Codex model.
  if (m.includes('gpt-5.2') || m.includes('gpt-5.1') || m.includes('gpt-5-codex') || m.includes('codex-mini-latest')) {
    return 'gpt-5.3-codex'
  }

  if (m.includes('gpt-5')) return 'gpt-5.5'
  if (m.includes('gpt-4o')) return 'gpt-5.4-mini'

  return model
}

function shouldUseGPT53StrictTextAssembly(model: string): boolean {
  return normalizeModel(model) === 'gpt-5.3-codex'
}

const GPT53_INTERNAL_PROTOCOL_MARKERS: RegExp[] = [
  /assistant to=functions\./i,
  /to=functions\./i,
  /tool read [^\n]* lines/i,
  /\{\s*"path"\s*:\s*".*localServer\.ts"/i,
]

function sanitizeGPT53Text(text: string): string {
  if (!text) return ''

  const firstMarker = GPT53_INTERNAL_PROTOCOL_MARKERS.reduce((first, marker) => {
    const idx = text.search(marker)
    if (idx < 0) return first
    return first < 0 ? idx : Math.min(first, idx)
  }, -1)

  if (firstMarker < 0) {
    return text
  }

  const prefix = text.slice(0, firstMarker).trim()
  if (!prefix) return ''

  if (prefix.length < 600 && /\b(need|inspect|gather|tool|maybe|let'?s)\b/i.test(prefix)) {
    return ''
  }

  return prefix
}

function decodeJwtPayload(token: string): any | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const payload = parts[1]
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

function extractAccountId(accessToken: string): string | null {
  const decoded = decodeJwtPayload(accessToken)
  if (!decoded) return null
  const authClaim = decoded[JWT_CLAIM_PATH]
  return authClaim?.chatgpt_account_id || null
}

function shouldRefresh(expiresAtIso?: string | null): boolean {
  if (!expiresAtIso) return false
  const expiresAt = Date.parse(expiresAtIso)
  if (!Number.isFinite(expiresAt)) return false
  return Date.now() >= expiresAt - 5 * 60 * 1000
}

async function refreshOpenAiAccessToken(refreshToken: string): Promise<RefreshedTokenPayload> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CLIENT_ID,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI token refresh failed (${response.status}): ${text}`)
  }

  const json = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('OpenAI token refresh response missing required fields')
  }

  const accountId = extractAccountId(json.access_token)
  if (!accountId) {
    throw new Error('OpenAI token refresh succeeded but account_id could not be derived from JWT')
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAtIso: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    accountId,
  }
}

function parseContentBlocks(blocks: any): any[] {
  if (!blocks) return []
  if (Array.isArray(blocks)) return blocks
  if (typeof blocks === 'string') {
    try {
      const parsed = JSON.parse(blocks)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function toInputTextContent(value: any): Array<{ type: 'input_text'; text: string }> {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [{ type: 'input_text', text: trimmed }] : []
  }

  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return { type: 'input_text' as const, text: item }
        if (item?.type === 'text' && typeof item?.content === 'string')
          return { type: 'input_text' as const, text: item.content }
        if (item?.type === 'text' && typeof item?.text === 'string')
          return { type: 'input_text' as const, text: item.text }
        if (item?.type === 'input_text' && typeof item?.text === 'string')
          return { type: 'input_text' as const, text: item.text }
        return null
      })
      .filter((item): item is { type: 'input_text'; text: string } => Boolean(item && item.text.trim()))
  }

  return []
}

function normalizeAttachmentImageUrl(attachment: any): string | null {
  if (!attachment) return null

  if (typeof attachment === 'string') {
    const trimmed = attachment.trim()
    if (!trimmed) return null
    if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
      return trimmed
    }
    return null
  }

  const candidate =
    attachment.dataUrl || attachment.dataURL || attachment.url || attachment.image_url || attachment.imageUrl || null

  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed) return null

  if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return null
}

function extractImageUrlFromContentPart(part: any): string | null {
  if (!part || typeof part !== 'object') return null

  if (part.type === 'input_image') {
    return normalizeAttachmentImageUrl(part.image_url || part.imageUrl || part.url || part.dataUrl || null)
  }

  if (part.type === 'image_url') {
    const nested = part.image_url
    const candidate = typeof nested === 'string' ? nested : nested?.url
    return normalizeAttachmentImageUrl(candidate)
  }

  if (part.type === 'image') {
    const direct = normalizeAttachmentImageUrl(part.url || part.dataUrl || part.image_url || part.imageUrl || null)
    if (direct) return direct

    const mediaType =
      typeof part.mimeType === 'string' ? part.mimeType : typeof part.mime === 'string' ? part.mime : 'image/png'
    if (typeof part.data === 'string' && part.data.trim().length > 0 && mediaType.startsWith('image/')) {
      const trimmed = part.data.trim()
      if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed
      return `data:${mediaType};base64,${trimmed}`
    }
  }

  if (part.type === 'file') {
    const mediaType =
      typeof part.mediaType === 'string' ? part.mediaType : typeof part.mime === 'string' ? part.mime : ''
    if (mediaType && mediaType.startsWith('image/')) {
      const direct = normalizeAttachmentImageUrl(part.url || part.dataUrl || part.image_url || null)
      if (direct) return direct

      if (typeof part.data === 'string' && part.data.trim().length > 0) {
        const trimmed = part.data.trim()
        if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed
        return `data:${mediaType};base64,${trimmed}`
      }
    }
  }

  return null
}

function collectUserMessageImageUrls(msg: any): string[] {
  const urls: string[] = []
  const seen = new Set<string>()

  const add = (candidate: any) => {
    const normalized = normalizeAttachmentImageUrl(candidate)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    urls.push(normalized)
  }

  const addFromPart = (part: any) => {
    const url = extractImageUrlFromContentPart(part)
    if (url) add(url)
  }

  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) addFromPart(part)
  }

  const artifacts = Array.isArray(msg?.artifacts) ? msg.artifacts : []
  for (const artifact of artifacts) add(artifact)

  const attachments = Array.isArray(msg?.attachments) ? msg.attachments : []
  for (const attachment of attachments) add(attachment)

  const contentBlocks = parseContentBlocks(msg?.content_blocks)
  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue
    addFromPart(block)
    add(block.image_url)
    add(block.imageUrl)
    add(block.url)
    add(block.dataUrl)

    if (Array.isArray(block.content)) {
      for (const part of block.content) addFromPart(part)
    }
  }

  return urls
}

function toUserInputContent(msg: any): any[] {
  const contentParts: any[] = []

  if (Array.isArray(msg?.content)) {
    for (const item of msg.content) {
      if (typeof item === 'string') {
        contentParts.push({ type: 'input_text', text: item })
        continue
      }
      if (item && typeof item === 'object') {
        if (item.type === 'input_text' && typeof item.text === 'string') {
          contentParts.push({ type: 'input_text', text: item.text })
          continue
        }
        if (item.type === 'text' && typeof item.text === 'string') {
          contentParts.push({ type: 'input_text', text: item.text })
          continue
        }
        if (item.type === 'text' && typeof item.content === 'string') {
          contentParts.push({ type: 'input_text', text: item.content })
          continue
        }

        const imageUrl = extractImageUrlFromContentPart(item)
        if (imageUrl) contentParts.push({ type: 'input_image', image_url: imageUrl })
      }
    }
  } else if (typeof msg?.content === 'string') {
    contentParts.push({ type: 'input_text', text: msg.content })
  } else if (msg?.content != null) {
    contentParts.push({ type: 'input_text', text: String(msg.content) })
  }

  const existingImageUrls = new Set(
    contentParts
      .filter(part => part?.type === 'input_image' && typeof part?.image_url === 'string')
      .map(part => part.image_url)
  )

  for (const url of collectUserMessageImageUrls(msg)) {
    if (!existingImageUrls.has(url)) {
      contentParts.push({ type: 'input_image', image_url: url })
      existingImageUrls.add(url)
    }
  }

  return contentParts.filter(part => {
    if (part?.type === 'input_text') return typeof part.text === 'string' && part.text.trim().length > 0
    if (part?.type === 'input_image') return typeof part.image_url === 'string' && part.image_url.trim().length > 0
    return false
  })
}

function appendImageAttachmentsToLatestUserMessage(input: any[], attachmentsBase64?: any[] | null): any[] {
  if (!Array.isArray(attachmentsBase64) || attachmentsBase64.length === 0) return input

  const imageParts = attachmentsBase64
    .map(attachment => normalizeAttachmentImageUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map(url => ({ type: 'input_image', image_url: url }))

  if (imageParts.length === 0) return input

  let latestUserIndex = -1
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    if (item?.type === 'message' && item?.role === 'user') {
      latestUserIndex = i
      break
    }
  }

  if (latestUserIndex >= 0) {
    const target = input[latestUserIndex]
    const existingContent = Array.isArray(target.content) ? [...target.content] : toInputTextContent(target.content)
    const existingImageUrls = new Set(
      existingContent
        .filter((part: any) => part?.type === 'input_image' && typeof part?.image_url === 'string')
        .map((part: any) => part.image_url)
    )

    for (const imagePart of imageParts) {
      if (!existingImageUrls.has(imagePart.image_url)) {
        existingContent.push(imagePart)
        existingImageUrls.add(imagePart.image_url)
      }
    }

    target.content = existingContent
  } else {
    input.push({ type: 'message', role: 'user', content: imageParts })
  }

  return input
}

const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
const AUTO_COMPACTION_SUMMARY_RESUME_LINE = 'Following is summary of the session, you have to resume the work.'
const GENERATED_IMAGE_PATH_HINT_NOTE = '__generated_image_path_hint__'

function getMessageTextContent(msg: any): string {
  const content = typeof msg?.content === 'string' ? msg.content : ''
  const plainText = typeof msg?.content_plain_text === 'string' ? msg.content_plain_text : ''
  return content || plainText
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

function toOutputTextContent(value: any): Array<{ type: 'output_text'; text: string }> {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [{ type: 'output_text', text: trimmed }] : []
  }

  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return { type: 'output_text' as const, text: item }
        if (item?.type === 'text' && typeof item?.content === 'string') {
          return { type: 'output_text' as const, text: item.content }
        }
        if (item?.type === 'text' && typeof item?.text === 'string') {
          return { type: 'output_text' as const, text: item.text }
        }
        if (item?.type === 'output_text' && typeof item?.text === 'string') {
          return { type: 'output_text' as const, text: item.text }
        }
        return null
      })
      .filter((item): item is { type: 'output_text'; text: string } => Boolean(item && item.text.trim()))
  }

  return []
}

function getToolCallName(raw: any): string {
  if (typeof raw?.name === 'string') return raw.name
  if (typeof raw?.function?.name === 'string') return raw.function.name
  return ''
}

function normalizeResponseMessageContent(content: any): Array<{ type: 'output_text'; text: string }> {
  if (!Array.isArray(content)) return []

  return content
    .map(part => {
      if (!part || typeof part !== 'object') return null
      if (part.type === 'output_text' && typeof part.text === 'string' && part.text.trim().length > 0) {
        return { type: 'output_text' as const, text: part.text }
      }
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
        return { type: 'output_text' as const, text: part.text }
      }
      return null
    })
    .filter((part): part is { type: 'output_text'; text: string } => Boolean(part))
}

function normalizeResponseOutputItemsForReplay(items: any[]): any[] {
  const normalized: any[] = []

  for (const item of items || []) {
    if (!item || typeof item !== 'object' || typeof item.type !== 'string') continue

    if (item.type === 'message') {
      const role = typeof item.role === 'string' ? item.role : 'assistant'
      const content = normalizeResponseMessageContent(item.content)
      if (content.length === 0) continue

      const messageItem: any = {
        type: 'message',
        role,
        content,
      }
      if (typeof item.id === 'string') messageItem.id = item.id
      if (typeof item.phase === 'string') messageItem.phase = item.phase
      if (typeof item.output_index === 'number') messageItem.output_index = item.output_index
      if (typeof item.outputIndex === 'number') messageItem.output_index = item.outputIndex
      normalized.push(messageItem)
      continue
    }

    if (item.type === 'function_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : ''
      const name = typeof item.name === 'string' ? item.name : ''
      const args =
        typeof item.arguments === 'string'
          ? item.arguments
          : item.arguments !== undefined
            ? JSON.stringify(item.arguments)
            : ''
      if (!callId || !name) continue

      const functionCallItem: any = {
        type: 'function_call',
        call_id: callId,
        name,
        arguments: args,
      }
      if (typeof item.id === 'string') functionCallItem.id = item.id
      if (typeof item.output_index === 'number') functionCallItem.output_index = item.output_index
      if (typeof item.outputIndex === 'number') functionCallItem.output_index = item.outputIndex
      normalized.push(functionCallItem)
      continue
    }

    if (item.type === 'reasoning') {
      const reasoningItem: any = { type: 'reasoning' }
      if (typeof item.id === 'string') reasoningItem.id = item.id
      if (Array.isArray(item.summary)) reasoningItem.summary = item.summary
      if (Array.isArray(item.content)) reasoningItem.content = item.content
      if (typeof item.output_index === 'number') reasoningItem.output_index = item.output_index
      if (typeof item.outputIndex === 'number') reasoningItem.output_index = item.outputIndex
      if ((item as any).encrypted_content) reasoningItem.encrypted_content = (item as any).encrypted_content
      normalized.push(reasoningItem)
      continue
    }

    if (item.type === 'image_generation_call') {
      const result = typeof item.result === 'string' ? item.result : ''
      if (!result.trim()) continue

      const imageItem: any = {
        type: 'image_generation_call',
        status: typeof item.status === 'string' ? item.status : 'completed',
        result,
      }
      if (typeof item.id === 'string') imageItem.id = item.id
      if (typeof item.revised_prompt === 'string') imageItem.revised_prompt = item.revised_prompt
      if (typeof item.output_index === 'number') imageItem.output_index = item.output_index
      if (typeof item.outputIndex === 'number') imageItem.output_index = item.outputIndex
      normalized.push(imageItem)
      continue
    }
  }

  return normalized
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

function toolCallArgumentsForCodex(toolCall: any): string {
  if (typeof toolCall?.arguments === 'string') return toolCall.arguments
  const rawArgs = toolCall?.arguments ?? toolCall?.args ?? toolCall?.input ?? {}
  try {
    return JSON.stringify(rawArgs ?? {})
  } catch {
    return '{}'
  }
}

function toolCallToCodexItem(toolCall: any): any | null {
  const callId = typeof toolCall?.id === 'string' && toolCall.id ? toolCall.id : ''
  const name = getToolCallName(toolCall)
  if (!callId || !name) return null
  return {
    type: 'function_call',
    name,
    arguments: toolCallArgumentsForCodex(toolCall),
    call_id: callId,
  }
}

function toolOutputToCodexItem(callId: string, content: any, toolName?: string | null): any {
  const sanitized = sanitizeToolResultContentForModel(content, toolName || null)
  return {
    type: 'function_call_output',
    call_id: callId,
    output: typeof sanitized === 'string' ? sanitized : (sanitized ?? null),
  }
}

function transformMessagesForCodex(history: any[], fallbackUserContent: string): any[] {
  const input: any[] = []
  const toolOutputIds = new Set<string>()
  const toolNameById = buildToolNameMap(history)

  for (const msg of history || []) {
    if (msg?.role === 'system' || msg?.role === 'developer') {
      if (msg?.role === 'system' && !isAutoCompactionSummaryMessage(msg) && !isGeneratedImagePathHintMessage(msg)) {
        continue
      }
      const content = toInputTextContent(getMessageTextContent(msg))
      if (content.length) {
        input.push({ type: 'message', role: 'developer', content })
      }
      continue
    }

    if (msg?.role === 'user') {
      const content = toUserInputContent(msg)
      if (content.length) {
        input.push({ type: 'message', role: 'user', content })
      }
      continue
    }

    if (msg?.role === 'assistant') {
      const assistantContent = toOutputTextContent(msg?.content)
      if (assistantContent.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: assistantContent })
      }

      for (const toolCall of parseJsonArray(msg?.tool_calls)) {
        const toolCallItem = toolCallToCodexItem(toolCall)
        if (toolCallItem) input.push(toolCallItem)
      }

      const contentBlocks = parseContentBlocks(msg?.content_blocks)
      for (const block of contentBlocks) {
        if (block?.type !== 'tool_result') continue
        const callId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : ''
        if (!callId || toolOutputIds.has(callId)) continue

        toolOutputIds.add(callId)
        input.push(toolOutputToCodexItem(callId, block.content, toolNameById.get(callId) || null))
      }

      continue
    }

    if (msg?.role === 'tool' && msg?.tool_call_id) {
      const callId = String(msg.tool_call_id)
      if (toolOutputIds.has(callId)) continue

      toolOutputIds.add(callId)
      input.push(toolOutputToCodexItem(callId, msg?.content, toolNameById.get(callId) || msg?.name || null))
      continue
    }
  }

  const hasUserMessage = input.some(item => item?.type === 'message' && item?.role === 'user')
  if (!hasUserMessage && fallbackUserContent.trim()) {
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: fallbackUserContent.trim() }],
    })
  }

  return input
}

function mapTools(tools: ProviderToolDefinition[]): any[] {
  return (tools || [])
    .filter(tool => tool?.name)
    .map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    }))
}

function getGeneratedImagesDirectoryHint(): { dir: string | null; pattern: string | null } {
  const userDataPath = process.env.YGG_APP_USER_DATA?.trim()
  if (!userDataPath) return { dir: null, pattern: null }
  const dir = path.join(userDataPath, 'generated_images')
  return { dir, pattern: path.join(dir, 'img-0001.<ext>') }
}

function hasImageGenerationIntent(input: ProviderGenerateInput): boolean {
  const imageConfig = input.railwayTurn?.imageConfig
  if (imageConfig && typeof imageConfig === 'object' && Object.keys(imageConfig).length > 0) return true

  const model = normalizeModel(input.modelName).toLowerCase()
  if (model.includes('gpt-image') || model.includes('image')) return true

  const text = `${input.userContent || ''}\n${(input.history || [])
    .slice(-3)
    .map(msg =>
      typeof msg?.content === 'string'
        ? msg.content
        : typeof msg?.content_plain_text === 'string'
          ? msg.content_plain_text
          : ''
    )
    .join('\n')}`

  return /\b(generate|create|make|draw|edit|render)\b[\s\S]{0,80}\b(image|picture|photo|illustration|icon|logo|sprite|asset)\b/i.test(
    text
  )
}

function getMimeTypeFromDataUrl(url: string): string {
  const match = /^data:([^;,]+)/i.exec(url)
  return match?.[1] || 'image/png'
}

function extractImageDataUrlFromOutputItem(item: any): string | null {
  if (!item || item.type !== 'image_generation_call') return null
  const result = typeof item.result === 'string' ? item.result.trim() : ''
  if (!result) return null
  if (/^data:image\//i.test(result) || /^https?:\/\//i.test(result)) return result
  return `data:image/png;base64,${result}`
}

function extractImageBlocksFromResponseItems(items: any[]): any[] {
  const blocks: any[] = []
  const seen = new Set<string>()

  for (const item of items || []) {
    const url = extractImageDataUrlFromOutputItem(item)
    if (!url || seen.has(url)) continue
    seen.add(url)
    blocks.push({
      type: 'image',
      url,
      mimeType: url.startsWith('data:image/') ? getMimeTypeFromDataUrl(url) : 'image/png',
    })
  }

  return blocks
}

function extractAssistantMessageTextFromReplayItem(item: any): string {
  if (!item || item.type !== 'message' || !Array.isArray(item.content)) return ''

  return item.content
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('')
}

function extractReasoningTextFromReplayItem(item: any): string {
  if (!item || item.type !== 'reasoning') return ''

  const parts: string[] = []

  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        parts.push(part.text)
      }
    }
  }

  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        parts.push(part.text)
      }
    }
  }

  return parts.join('\n\n').trim()
}

function extractToolCallsFromReplayItems(items: any[]): ProviderToolCall[] {
  return (items || [])
    .filter(item => item?.type === 'function_call' && (item?.call_id || item?.id) && item?.name)
    .map(item => {
      const callId = typeof item.call_id === 'string' ? item.call_id : item.id
      const argsRaw = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})

      let parsedArgs: any = argsRaw
      try {
        parsedArgs = JSON.parse(argsRaw)
      } catch {
        // keep raw string
      }

      return {
        id: callId,
        name: item.name,
        arguments: parsedArgs,
        status: 'pending' as const,
      }
    })
}

function selectFinalTextFromReplayItems(
  replayItems: any[],
  fallbackText: string,
  useGPT53StrictTextAssembly: boolean
): string {
  const assistantMessages = (replayItems || [])
    .filter(item => item?.type === 'message' && item?.role === 'assistant')
    .map((item: any) => {
      const rawText = extractAssistantMessageTextFromReplayItem(item)
      const text = useGPT53StrictTextAssembly ? sanitizeGPT53Text(rawText) : rawText
      return {
        text,
        phase: typeof item?.phase === 'string' ? item.phase : undefined,
      }
    })
    .filter((entry: { text: string }) => entry.text.trim().length > 0)

  const finalAnswerEntry = [...assistantMessages].reverse().find(entry => entry.phase === 'final_answer')
  const fallbackEntry = [...assistantMessages].reverse().find(entry => entry.phase !== 'commentary')
  const lastEntry = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null
  const fallback = useGPT53StrictTextAssembly ? sanitizeGPT53Text(fallbackText) : fallbackText

  return finalAnswerEntry?.text || fallbackEntry?.text || lastEntry?.text || fallback
}

function selectReasoningFromReplayItems(replayItems: any[], fallbackReasoning: string): string {
  const reasoningSegments = (replayItems || [])
    .map((item: any) => extractReasoningTextFromReplayItem(item))
    .filter((text: string) => text.trim().length > 0)

  return reasoningSegments.join('\n\n').trim() || fallbackReasoning
}

type OpenAiResponseUsage = {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number } | null
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number } | null
  total_tokens?: number
}

type CodexParsedOutput = {
  text: string
  reasoning: string
  toolCalls: ProviderToolCall[]
  responseOutputItems: any[]
  responseId?: string
  responseItemsAdded: any[]
  usage?: OpenAiResponseUsage
  debug?: {
    eventCounts: Record<string, number>
    outputItemCount: number
    addedItemCount: number
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isOpenAiChatgptDebugLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.YGG_OPENAI_CHATGPT_DEBUG_LOGS || '')
}

function isCodexDevLoggingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.YGG_CODEX_DEV_LOGS || '')
}

function createOpenAiChatgptTraceId(input: ProviderGenerateInput): string {
  const base = input.railwayTurn?.conversationId?.trim() || input.userId || 'ygg-chat'
  return `${base}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function previewForLog(value: unknown, maxLength = 600): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (!raw) return ''
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...<truncated:${raw.length}>` : raw
}

function summarizeContentPart(part: any): Record<string, unknown> {
  if (!part || typeof part !== 'object') return { type: typeof part }
  const type = typeof part.type === 'string' ? part.type : 'unknown'
  if (type === 'input_text' || type === 'output_text' || type === 'text') {
    const text = typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : ''
    return { type, textLength: text.length }
  }
  if (type === 'input_image' || type === 'image_url' || type === 'image') {
    const imageUrl = part.image_url || part.imageUrl || part.url || part.dataUrl
    return { type, hasImageUrl: typeof imageUrl === 'string' && imageUrl.length > 0 }
  }
  return { type }
}

function summarizeInputItem(item: any): Record<string, unknown> {
  if (!item || typeof item !== 'object') return { type: typeof item }
  const content = Array.isArray(item.content) ? item.content : []
  return {
    type: item.type,
    role: item.role,
    contentParts: content.length,
    contentSummary: content.slice(0, 6).map(summarizeContentPart),
  }
}

function summarizeOpenAiChatgptRequestBody(body: any): Record<string, unknown> {
  const inputItems = Array.isArray(body?.input) ? body.input : []
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return {
    model: body?.model,
    stream: body?.stream,
    store: body?.store,
    serviceTier: body?.service_tier,
    promptCacheKey: body?.prompt_cache_key,
    promptCacheRetention: body?.prompt_cache_retention || 'in_memory',
    hasPreviousResponseId: typeof body?.previous_response_id === 'string' && body.previous_response_id.length > 0,
    previousResponseId: body?.previous_response_id,
    instructionLength: typeof body?.instructions === 'string' ? body.instructions.length : 0,
    inputItems: inputItems.length,
    inputSummary: inputItems.slice(0, 12).map(summarizeInputItem),
    tools: tools.length,
    toolNames: tools.map((tool: any) => tool?.name || tool?.function?.name || tool?.type).filter(Boolean),
    toolChoice: body?.tool_choice,
    parallelToolCalls: body?.parallel_tool_calls,
    include: body?.include,
    reasoning: body?.reasoning,
  }
}

function summarizeParsedOpenAiChatgptOutput(parsed: CodexParsedOutput): Record<string, unknown> {
  return {
    responseId: parsed.responseId,
    textLength: parsed.text.length,
    reasoningLength: parsed.reasoning.length,
    toolCalls: parsed.toolCalls.length,
    toolCallNames: parsed.toolCalls.map(call => call.name),
    responseOutputItems: parsed.responseOutputItems.length,
    responseItemsAdded: parsed.responseItemsAdded.length,
    outputItemTypes: parsed.responseOutputItems.map((item: any) => item?.type).filter(Boolean),
    usage: parsed.usage,
    eventCounts: parsed.debug?.eventCounts,
  }
}

function summarizeOpenAiEvent(parsed: any): Record<string, unknown> {
  const item = parsed?.item
  const response = parsed?.response
  return {
    type: parsed?.type,
    itemId: parsed?.item_id || parsed?.itemId || parsed?.id || item?.id,
    itemType: item?.type,
    itemRole: item?.role,
    itemPhase: item?.phase,
    outputIndex: parsed?.output_index ?? parsed?.outputIndex ?? item?.output_index ?? item?.outputIndex,
    deltaLength: typeof parsed?.delta === 'string' ? parsed.delta.length : undefined,
    textLength: typeof parsed?.text === 'string' ? parsed.text.length : undefined,
    responseId: response?.id,
    responseStatus: response?.status,
    responseError: response?.error,
    incompleteDetails: response?.incomplete_details,
  }
}

function logOpenAiChatgpt(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) {
  if (!isOpenAiChatgptDebugLoggingEnabled()) return
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  logger(`[OpenAI ChatGPT] ${message}`, details || {})
}

function logCodexUsage(params: {
  model: string
  responseId?: string
  promptCacheKey?: string
  promptCacheRetention: 'in_memory' | '24h'
  requestMode?: 'full_replay' | 'qubit_exact_full_replay'
  inputItems?: number
  hasPreviousResponseId?: boolean
  usage?: OpenAiResponseUsage
}) {
  if (!isCodexDevLoggingEnabled()) return

  const usage = params.usage
  if (!usage) return

  const inputTokens = numberOrZero(usage.input_tokens)
  const cachedInputTokens = numberOrZero(usage.input_tokens_details?.cached_tokens)
  const outputTokens = numberOrZero(usage.output_tokens)
  const reasoningTokens = numberOrZero(usage.output_tokens_details?.reasoning_tokens)
  const totalTokens = numberOrZero(usage.total_tokens)
  const uncachedInputTokens = Math.max(inputTokens - cachedInputTokens, 0)
  const cacheHitRate = inputTokens > 0 ? cachedInputTokens / inputTokens : 0

  console.info('[Codex Usage]', {
    model: params.model,
    responseId: params.responseId,
    promptCacheKey: params.promptCacheKey,
    promptCacheRetention: params.promptCacheRetention,
    requestMode: params.requestMode,
    inputItems: params.inputItems,
    hasPreviousResponseId: params.hasPreviousResponseId,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    cacheHitRate: `${(cacheHitRate * 100).toFixed(2)}%`,
    outputTokens,
    reasoningTokens,
    totalTokens,
  })
}

function createCodexEventParser(params: { emit?: ProviderStreamEventHandler; modelName: string; traceId?: string }) {
  const { emit, modelName, traceId } = params
  const useGPT53StrictTextAssembly = shouldUseGPT53StrictTextAssembly(modelName)
  let streamedText = ''
  let streamedReasoning = ''
  let completedOutputItems: any[] | null = null
  let completedResponseId: string | undefined
  let completedUsage: OpenAiResponseUsage | undefined
  const callByItemId = new Map<
    string,
    { id: string; name: string; arguments: string; outputIndex?: number; seq: number }
  >()
  const responseOutputItemsById = new Map<
    string,
    { id: string; type?: string; role?: string; phase?: string; outputIndex?: number; seq: number }
  >()
  const addedResponseItems: any[] = []
  const responseTextByItem = new Map<string, { text: string; outputIndex?: number; seq: number; fromDone: boolean }>()
  const imageGenerationItemsById = new Map<string, any>()
  const reasoningByKey = new Map<string, string>()
  const eventCounts = new Map<string, number>()
  let callSeq = 0
  let responseSeq = 0

  const extractItemId = (evt: any): string => {
    const raw = evt?.item_id ?? evt?.itemId ?? evt?.id ?? ''
    return typeof raw === 'string' ? raw : ''
  }
  const extractIndex = (evt: any, snakeKey: string, camelKey: string): number | undefined => {
    const raw = evt?.[snakeKey] ?? evt?.[camelKey]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }
  const mergeOutputItem = (item: any) => {
    if (!item?.id || typeof item.id !== 'string') return
    const existing = responseOutputItemsById.get(item.id)
    const outputIndex =
      typeof item.output_index === 'number'
        ? item.output_index
        : typeof item.outputIndex === 'number'
          ? item.outputIndex
          : existing?.outputIndex
    responseOutputItemsById.set(item.id, {
      id: item.id,
      type: typeof item.type === 'string' ? item.type : existing?.type,
      role: typeof item.role === 'string' ? item.role : existing?.role,
      phase: typeof item.phase === 'string' ? item.phase : existing?.phase,
      outputIndex,
      seq: existing?.seq ?? responseSeq++,
    })
  }
  const upsertResponseText = (itemId: string, text: string, outputIndex?: number, fromDone: boolean = false) => {
    const existing = responseTextByItem.get(itemId)
    responseTextByItem.set(itemId, {
      text: fromDone ? text : (existing?.text || '') + text,
      outputIndex: typeof outputIndex === 'number' ? outputIndex : existing?.outputIndex,
      seq: existing?.seq ?? responseSeq++,
      fromDone: fromDone || Boolean(existing?.fromDone),
    })
  }
  const shouldEmitTextForEvent = (evt: any): boolean => {
    if (!useGPT53StrictTextAssembly) return true
    const itemId = extractItemId(evt)
    if (!itemId) return false
    const meta = responseOutputItemsById.get(itemId)
    if (!meta) return false
    if (meta.type && meta.type !== 'message') return false
    if (meta.role && meta.role !== 'assistant') return false
    if (meta.phase && meta.phase !== 'final_answer') return false
    return true
  }
  const emitReasoning = (delta: string) => {
    if (!delta) return
    streamedReasoning += delta
    emit?.({ type: 'chunk', part: 'reasoning', delta })
  }
  const applyReasoningDelta = (key: string, delta: string) => {
    if (!delta) return
    const prev = reasoningByKey.get(key) || ''
    reasoningByKey.set(key, prev + delta)
    emitReasoning(delta)
  }
  const applyReasoningDone = (key: string, fullText: string) => {
    if (!fullText) return
    const prev = reasoningByKey.get(key) || ''
    reasoningByKey.set(key, fullText)
    if (fullText.startsWith(prev)) emitReasoning(fullText.slice(prev.length))
    else if (!prev) emitReasoning(fullText)
  }
  const extractReasoningFromOutputItem = (item: any) => {
    if (!item || item.type !== 'reasoning') return
    const itemId = typeof item.id === 'string' ? item.id : 'unknown-reasoning-item'
    if (Array.isArray(item.content))
      item.content.forEach((part: any, i: number) => {
        if (part?.type === 'reasoning_text' && typeof part.text === 'string')
          applyReasoningDone(`reasoning_text:${itemId}:${i}`, part.text)
      })
    if (Array.isArray(item.summary))
      item.summary.forEach((part: any, i: number) => {
        if (typeof part?.text === 'string') applyReasoningDone(`reasoning_summary:${itemId}:${i}`, part.text)
      })
  }
  const buildFallbackResponseOutputItems = (): any[] => {
    const fallbackMessages = Array.from(responseOutputItemsById.values())
      .filter(item => (!item.type || item.type === 'message') && (!item.role || item.role === 'assistant'))
      .sort((a, b) =>
        typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number'
          ? a.outputIndex - b.outputIndex
          : typeof a.outputIndex === 'number'
            ? -1
            : typeof b.outputIndex === 'number'
              ? 1
              : a.seq - b.seq
      )
      .map(item => {
        const text = responseTextByItem.get(item.id)?.text || ''
        if (!text.trim()) return null
        return {
          type: 'message',
          id: item.id,
          role: item.role || 'assistant',
          phase: item.phase,
          output_index: item.outputIndex,
          content: [{ type: 'output_text', text }],
        }
      })
      .filter(Boolean)
    const fallbackFunctionCalls = Array.from(callByItemId.values())
      .sort((a, b) =>
        typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number'
          ? a.outputIndex - b.outputIndex
          : typeof a.outputIndex === 'number'
            ? -1
            : typeof b.outputIndex === 'number'
              ? 1
              : a.seq - b.seq
      )
      .map(call => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments || '',
        output_index: call.outputIndex,
      }))
      .filter(call => call.call_id && call.name)
    const fallbackImages = Array.from(imageGenerationItemsById.values())
    return normalizeResponseOutputItemsForReplay([...fallbackMessages, ...fallbackFunctionCalls, ...fallbackImages])
  }
  const handle = (parsed: any) => {
    if (!parsed) return
    const eventType = typeof parsed.type === 'string' ? parsed.type : 'unknown'
    eventCounts.set(eventType, (eventCounts.get(eventType) || 0) + 1)
    logOpenAiChatgpt('info', 'stream event', {
      traceId,
      ...summarizeOpenAiEvent(parsed),
    })
    if (parsed.type === 'response.output_item.added' || parsed.type === 'response.output_item.done') {
      const item = parsed.item
      mergeOutputItem(item)
      if (parsed.type === 'response.output_item.done' && item && typeof item === 'object') {
        addedResponseItems.push(item)
      }
      if (item?.type === 'function_call' && item?.id) {
        const existing = callByItemId.get(item.id)
        const outputIndex =
          typeof item.output_index === 'number'
            ? item.output_index
            : typeof item.outputIndex === 'number'
              ? item.outputIndex
              : existing?.outputIndex
        if (existing) {
          existing.id = item.call_id || item.id
          existing.name = item.name || existing.name
          existing.arguments = item.arguments ?? existing.arguments
          existing.outputIndex = outputIndex
        } else
          callByItemId.set(item.id, {
            id: item.call_id || item.id,
            name: item.name || '',
            arguments: item.arguments || '',
            outputIndex,
            seq: callSeq++,
          })
      }
      if (item?.type === 'image_generation_call' && item?.id) {
        imageGenerationItemsById.set(item.id, item)
      }
      if (parsed.type === 'response.output_item.done') {
        if (item?.type === 'message' && item?.id) {
          const text = extractAssistantMessageTextFromReplayItem({
            type: 'message',
            content: normalizeResponseMessageContent(item.content),
          })
          if (text) upsertResponseText(item.id, text, extractIndex(item, 'output_index', 'outputIndex'), true)
        }
        extractReasoningFromOutputItem(item)
      }
      return
    }
    if (parsed.type === 'response.output_text.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
      if (!delta) return
      const itemId = extractItemId(parsed)
      if (itemId) upsertResponseText(itemId, delta, extractIndex(parsed, 'output_index', 'outputIndex'), false)
      if (shouldEmitTextForEvent(parsed)) {
        streamedText += delta
        emit?.({ type: 'chunk', part: 'text', delta })
      }
      return
    }
    if (parsed.type === 'response.output_text.done') {
      const itemId = extractItemId(parsed)
      if (itemId && typeof parsed.text === 'string')
        upsertResponseText(itemId, parsed.text, extractIndex(parsed, 'output_index', 'outputIndex'), true)
      return
    }
    if (parsed.type === 'response.reasoning_text.delta' && typeof parsed.delta === 'string') {
      const itemId = extractItemId(parsed) || 'reasoning'
      applyReasoningDelta(
        `reasoning_text:${itemId}:${extractIndex(parsed, 'content_index', 'contentIndex') || 0}`,
        parsed.delta
      )
      return
    }
    if (parsed.type === 'response.reasoning_summary_text.delta' && typeof parsed.delta === 'string') {
      const itemId = extractItemId(parsed) || 'reasoning'
      applyReasoningDelta(
        `reasoning_summary:${itemId}:${extractIndex(parsed, 'summary_index', 'summaryIndex') || 0}`,
        parsed.delta
      )
      return
    }
    if (parsed.type === 'response.function_call_arguments.delta') {
      const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : null
      if (!itemId) return
      const existing = callByItemId.get(itemId)
      if (existing) existing.arguments += parsed.delta || ''
      else callByItemId.set(itemId, { id: itemId, name: '', arguments: parsed.delta || '', seq: callSeq++ })
      return
    }
    if (parsed.type === 'response.function_call_arguments.done') {
      const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : null
      if (!itemId) return
      const existing = callByItemId.get(itemId)
      if (existing) existing.arguments = parsed.arguments || existing.arguments
      else callByItemId.set(itemId, { id: itemId, name: '', arguments: parsed.arguments || '', seq: callSeq++ })
      return
    }
    if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
      const responseError = parsed?.response?.error
      throw new Error(
        typeof responseError?.message === 'string' && responseError.message.trim()
          ? responseError.message
          : parsed.type === 'response.incomplete'
            ? 'OpenAI response was incomplete.'
            : 'OpenAI response failed.'
      )
    }
    if (parsed.type === 'error') {
      const err = parsed.error
      throw new Error(typeof err?.message === 'string' ? err.message : 'OpenAI websocket returned an error event.')
    }
    if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
      if (typeof parsed?.response?.id === 'string') completedResponseId = parsed.response.id
      if (parsed?.response?.usage && typeof parsed.response.usage === 'object') {
        completedUsage = parsed.response.usage as OpenAiResponseUsage
      }
      if (Array.isArray(parsed?.response?.output)) completedOutputItems = parsed.response.output
    }
  }
  const finish = (): CodexParsedOutput => {
    const normalizedCompletedOutputItems = normalizeResponseOutputItemsForReplay(completedOutputItems || [])
    const fallbackOutputItems = buildFallbackResponseOutputItems()
    const completedImageIds = new Set(
      normalizedCompletedOutputItems
        .filter((item: any) => item?.type === 'image_generation_call' && typeof item?.id === 'string')
        .map((item: any) => item.id)
    )
    const missingFallbackImages = fallbackOutputItems.filter(
      (item: any) => item?.type === 'image_generation_call' && (!item.id || !completedImageIds.has(item.id))
    )
    const responseOutputItems =
      normalizedCompletedOutputItems.length > 0
        ? [...normalizedCompletedOutputItems, ...missingFallbackImages]
        : fallbackOutputItems
    const output = {
      text: selectFinalTextFromReplayItems(responseOutputItems, streamedText, useGPT53StrictTextAssembly),
      reasoning: selectReasoningFromReplayItems(responseOutputItems, streamedReasoning),
      toolCalls: extractToolCallsFromReplayItems(responseOutputItems),
      responseOutputItems,
      responseId: completedResponseId,
      responseItemsAdded: normalizeResponseOutputItemsForReplay(addedResponseItems),
      usage: completedUsage,
      debug: {
        eventCounts: Object.fromEntries(eventCounts.entries()),
        outputItemCount: responseOutputItems.length,
        addedItemCount: addedResponseItems.length,
      },
    }
    logOpenAiChatgpt('info', 'parser finish', {
      traceId,
      ...summarizeParsedOpenAiChatgptOutput(output),
    })
    return output
  }
  return { handle, finish }
}

async function readCodexSseOutput(params: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  firstRead?: ReadableStreamReadResult<Uint8Array> | null
  emit?: ProviderStreamEventHandler
  modelName: string
  traceId?: string
}): Promise<CodexParsedOutput> {
  /* legacy parser body retained but bypassed below */
  const parser = createCodexEventParser({ emit: params.emit, modelName: params.modelName, traceId: params.traceId })
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingRead: ReadableStreamReadResult<Uint8Array> | null = params.firstRead ?? null
  let chunkCount = 0
  let byteCount = 0
  let dataEventCount = 0
  let doneMarkerSeen = false
  logOpenAiChatgpt('info', 'SSE parser start', { traceId: params.traceId, hasFirstRead: Boolean(params.firstRead) })
  while (true) {
    const readResult = pendingRead ?? (await params.reader.read())
    pendingRead = null
    const { done, value } = readResult
    if (done) break
    chunkCount++
    byteCount += value?.byteLength || 0
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        doneMarkerSeen = true
        logOpenAiChatgpt('info', 'SSE done marker', { traceId: params.traceId })
        continue
      }
      dataEventCount++
      try {
        parser.handle(JSON.parse(payload))
      } catch (error) {
        if (error instanceof SyntaxError) {
          logOpenAiChatgpt('warn', 'SSE JSON parse failed', {
            traceId: params.traceId,
            error: error.message,
            payloadPreview: previewForLog(payload),
          })
          continue
        }
        throw error
      }
    }
  }
  logOpenAiChatgpt('info', 'SSE reader ended', {
    traceId: params.traceId,
    chunkCount,
    byteCount,
    dataEventCount,
    doneMarkerSeen,
    trailingBufferLength: buffer.length,
  })
  return parser.finish()
}

async function readCodexWebSocketOutput(params: {
  endpoint: string
  headers: Record<string, string>
  body: any
  emit?: ProviderStreamEventHandler
  modelName: string
  traceId?: string
  timeoutMs?: number
}): Promise<CodexParsedOutput> {
  const parser = createCodexEventParser({ emit: params.emit, modelName: params.modelName, traceId: params.traceId })
  const wsEndpoint = params.endpoint.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
  logOpenAiChatgpt('info', 'WebSocket connect', {
    traceId: params.traceId,
    endpoint: wsEndpoint,
    timeoutMs: params.timeoutMs ?? 120000,
  })
  return await new Promise<CodexParsedOutput>((resolve, reject) => {
    let settled = false
    let completed = false
    let messageCount = 0
    let byteCount = 0
    const ws = new WebSocket(wsEndpoint, { headers: params.headers, perMessageDeflate: true })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      const parsed = parser.finish()
      logOpenAiChatgpt('info', 'WebSocket finished', {
        traceId: params.traceId,
        completed,
        messageCount,
        byteCount,
        ...summarizeParsedOpenAiChatgptOutput(parsed),
      })
      resolve(parsed)
    }
    const fail = (error: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      logOpenAiChatgpt('error', 'WebSocket failed', {
        traceId: params.traceId,
        completed,
        messageCount,
        byteCount,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const timer = setTimeout(() => fail(new Error('OpenAI websocket idle timeout')), params.timeoutMs ?? 120000)
    const bumpTimer = () => {
      timer.refresh?.()
    }
    ws.on('open', () => {
      bumpTimer()
      logOpenAiChatgpt('info', 'WebSocket open; sending response.create', {
        traceId: params.traceId,
        request: summarizeOpenAiChatgptRequestBody(params.body),
      })
      ws.send(JSON.stringify({ type: 'response.create', ...params.body }), err => {
        if (err) fail(err)
        else logOpenAiChatgpt('info', 'WebSocket response.create sent', { traceId: params.traceId })
      })
    })
    ws.on('message', data => {
      bumpTimer()
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : data.toString()
      messageCount++
      byteCount += Buffer.byteLength(text, 'utf8')
      try {
        const parsed = JSON.parse(text)
        parser.handle(parsed)
        if (parsed?.type === 'response.completed' || parsed?.type === 'response.done') {
          completed = true
          finish()
        }
      } catch (error) {
        logOpenAiChatgpt('error', 'WebSocket message handling failed', {
          traceId: params.traceId,
          error: error instanceof Error ? error.message : String(error),
          payloadPreview: previewForLog(text),
        })
        fail(error)
      }
    })
    ws.on('error', fail)
    ws.on('close', (code, reason) => {
      logOpenAiChatgpt('info', 'WebSocket close', {
        traceId: params.traceId,
        code,
        reason: reason?.length ? reason.toString() : '',
        completed,
        settled,
        messageCount,
        byteCount,
      })
      if (settled) return
      if (completed) finish()
      else fail(new Error(`OpenAI websocket closed before completion${reason?.length ? `: ${reason.toString()}` : ''}`))
    })
  })
}

async function readCodexSseOutputLegacy_DISABLED(params: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  firstRead?: ReadableStreamReadResult<Uint8Array> | null
  emit?: ProviderStreamEventHandler
  modelName: string
}): Promise<{
  text: string
  reasoning: string
  toolCalls: ProviderToolCall[]
  responseOutputItems: any[]
}> {
  const { reader, firstRead, emit, modelName } = params
  const decoder = new TextDecoder()
  let buffer = ''

  const useGPT53StrictTextAssembly = shouldUseGPT53StrictTextAssembly(modelName)
  let streamedText = ''
  let streamedReasoning = ''
  let completedOutputItems: any[] | null = null

  const callByItemId = new Map<
    string,
    {
      id: string
      name: string
      arguments: string
      outputIndex?: number
      seq: number
    }
  >()
  const responseOutputItemsById = new Map<
    string,
    {
      id: string
      type?: string
      role?: string
      phase?: string
      outputIndex?: number
      seq: number
    }
  >()
  const responseTextByItem = new Map<
    string,
    {
      text: string
      outputIndex?: number
      seq: number
      fromDone: boolean
    }
  >()
  const reasoningByKey = new Map<string, string>()
  let callSeq = 0
  let responseSeq = 0
  let pendingRead: ReadableStreamReadResult<Uint8Array> | null = firstRead ?? null

  const extractItemId = (evt: any): string => {
    const raw = evt?.item_id ?? evt?.itemId ?? evt?.id ?? ''
    return typeof raw === 'string' ? raw : ''
  }

  const extractIndex = (evt: any, snakeKey: string, camelKey: string): number | undefined => {
    const raw = evt?.[snakeKey] ?? evt?.[camelKey]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }

  const mergeOutputItem = (item: any) => {
    if (!item?.id || typeof item.id !== 'string') return

    const existing = responseOutputItemsById.get(item.id)
    const outputIndex =
      typeof item.output_index === 'number'
        ? item.output_index
        : typeof item.outputIndex === 'number'
          ? item.outputIndex
          : existing?.outputIndex

    responseOutputItemsById.set(item.id, {
      id: item.id,
      type: typeof item.type === 'string' ? item.type : existing?.type,
      role: typeof item.role === 'string' ? item.role : existing?.role,
      phase: typeof item.phase === 'string' ? item.phase : existing?.phase,
      outputIndex,
      seq: existing?.seq ?? responseSeq++,
    })
  }

  const upsertResponseText = (itemId: string, text: string, outputIndex?: number, fromDone: boolean = false) => {
    const existing = responseTextByItem.get(itemId)
    responseTextByItem.set(itemId, {
      text: fromDone ? text : (existing?.text || '') + text,
      outputIndex: typeof outputIndex === 'number' ? outputIndex : existing?.outputIndex,
      seq: existing?.seq ?? responseSeq++,
      fromDone: fromDone || Boolean(existing?.fromDone),
    })
  }

  const shouldEmitTextForEvent = (evt: any): boolean => {
    if (!useGPT53StrictTextAssembly) return true
    const itemId = extractItemId(evt)
    if (!itemId) return false
    const meta = responseOutputItemsById.get(itemId)
    if (!meta) return false
    if (meta.type && meta.type !== 'message') return false
    if (meta.role && meta.role !== 'assistant') return false
    if (meta.phase && meta.phase !== 'final_answer') return false
    return true
  }

  const emitReasoning = (delta: string) => {
    if (!delta) return
    streamedReasoning += delta
    emit?.({ type: 'chunk', part: 'reasoning', delta })
  }

  const applyReasoningDelta = (key: string, delta: string) => {
    if (!delta) return
    const prev = reasoningByKey.get(key) || ''
    reasoningByKey.set(key, prev + delta)
    emitReasoning(delta)
  }

  const applyReasoningDone = (key: string, fullText: string) => {
    if (!fullText) return

    const prev = reasoningByKey.get(key) || ''
    reasoningByKey.set(key, fullText)

    if (fullText.startsWith(prev)) {
      emitReasoning(fullText.slice(prev.length))
      return
    }

    if (prev) {
      return
    }

    emitReasoning(fullText)
  }

  const extractReasoningFromOutputItem = (item: any) => {
    if (!item || item.type !== 'reasoning') return

    const itemId = typeof item.id === 'string' ? item.id : 'unknown-reasoning-item'

    if (Array.isArray(item.content)) {
      item.content.forEach((part: any, contentIndex: number) => {
        if (part?.type === 'reasoning_text' && typeof part.text === 'string' && part.text) {
          applyReasoningDone(`reasoning_text:${itemId}:${contentIndex}`, part.text)
        }
      })
    }

    if (Array.isArray(item.summary)) {
      item.summary.forEach((part: any, summaryIndex: number) => {
        if (typeof part?.text === 'string' && part.text) {
          applyReasoningDone(`reasoning_summary:${itemId}:${summaryIndex}`, part.text)
        }
      })
    }
  }

  const buildFallbackResponseOutputItems = (): any[] => {
    const fallbackMessages = Array.from(responseOutputItemsById.values())
      .filter(item => (!item.type || item.type === 'message') && (!item.role || item.role === 'assistant'))
      .sort((a, b) => {
        if (typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number') return a.outputIndex - b.outputIndex
        if (typeof a.outputIndex === 'number') return -1
        if (typeof b.outputIndex === 'number') return 1
        return a.seq - b.seq
      })
      .map(item => {
        const textEntry = responseTextByItem.get(item.id)
        const text = textEntry?.text || ''
        if (!text.trim()) return null
        return {
          type: 'message',
          id: item.id,
          role: item.role || 'assistant',
          phase: item.phase,
          output_index: item.outputIndex,
          content: [{ type: 'output_text', text }],
        }
      })
      .filter(Boolean)

    const fallbackFunctionCalls = Array.from(callByItemId.values())
      .sort((a, b) => {
        if (typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number') return a.outputIndex - b.outputIndex
        if (typeof a.outputIndex === 'number') return -1
        if (typeof b.outputIndex === 'number') return 1
        return a.seq - b.seq
      })
      .map(call => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments || '',
        output_index: call.outputIndex,
      }))
      .filter(call => call.call_id && call.name)

    return normalizeResponseOutputItemsForReplay([...fallbackMessages, ...fallbackFunctionCalls])
  }

  while (true) {
    const readResult = pendingRead ?? (await reader.read())
    pendingRead = null

    const { done, value } = readResult
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue

      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      let parsed: any = null
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }

      if (!parsed) continue

      if (parsed.type === 'response.output_item.added' || parsed.type === 'response.output_item.done') {
        const item = parsed.item
        mergeOutputItem(item)

        if (item?.type === 'function_call' && item?.id) {
          const existing = callByItemId.get(item.id)
          const outputIndex =
            typeof item.output_index === 'number'
              ? item.output_index
              : typeof item.outputIndex === 'number'
                ? item.outputIndex
                : existing?.outputIndex
          if (existing) {
            existing.id = item.call_id || item.id
            existing.name = item.name || existing.name
            existing.arguments = item.arguments ?? existing.arguments
            existing.outputIndex = outputIndex
          } else {
            callByItemId.set(item.id, {
              id: item.call_id || item.id,
              name: item.name || '',
              arguments: item.arguments || '',
              outputIndex,
              seq: callSeq++,
            })
          }
        }

        if (parsed.type === 'response.output_item.done') {
          if (item?.type === 'message' && item?.id) {
            const text = extractAssistantMessageTextFromReplayItem({
              type: 'message',
              content: normalizeResponseMessageContent(item.content),
            })
            if (text) {
              upsertResponseText(item.id, text, extractIndex(item, 'output_index', 'outputIndex'), true)
            }
          }
          extractReasoningFromOutputItem(item)
        }
        continue
      }

      if (parsed.type === 'response.output_text.delta') {
        const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
        if (!delta) continue

        const itemId = extractItemId(parsed)
        const outputIndex = extractIndex(parsed, 'output_index', 'outputIndex')
        if (itemId) {
          upsertResponseText(itemId, delta, outputIndex, false)
        }

        if (shouldEmitTextForEvent(parsed)) {
          streamedText += delta
          emit?.({ type: 'chunk', part: 'text', delta })
        }
        continue
      }

      if (parsed.type === 'response.output_text.done') {
        const fullText = typeof parsed.text === 'string' ? parsed.text : ''
        if (!fullText) continue

        const itemId = extractItemId(parsed)
        if (!itemId) continue
        upsertResponseText(itemId, fullText, extractIndex(parsed, 'output_index', 'outputIndex'), true)
        continue
      }

      if (parsed.type === 'response.reasoning_text.delta' && typeof parsed.delta === 'string') {
        const itemId = extractItemId(parsed) || 'reasoning'
        applyReasoningDelta(
          `reasoning_text:${itemId}:${extractIndex(parsed, 'content_index', 'contentIndex') || 0}`,
          parsed.delta
        )
        continue
      }

      if (parsed.type === 'response.reasoning_summary_text.delta' && typeof parsed.delta === 'string') {
        const itemId = extractItemId(parsed) || 'reasoning'
        applyReasoningDelta(
          `reasoning_summary:${itemId}:${extractIndex(parsed, 'summary_index', 'summaryIndex') || 0}`,
          parsed.delta
        )
        continue
      }

      if (
        parsed.type === 'response.reasoning_text.done' ||
        parsed.type === 'response.reasoning_summary_text.done' ||
        parsed.type === 'response.reasoning_summary_part.done' ||
        parsed.type === 'response.content_part.done' ||
        parsed.type === 'response.reasoning.delta'
      ) {
        continue
      }

      if (parsed.type === 'response.function_call_arguments.delta') {
        const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : null
        if (!itemId) continue

        const existing = callByItemId.get(itemId)
        if (existing) {
          existing.arguments += parsed.delta || ''
        } else {
          callByItemId.set(itemId, {
            id: itemId,
            name: '',
            arguments: parsed.delta || '',
            seq: callSeq++,
          })
        }
        continue
      }

      if (parsed.type === 'response.function_call_arguments.done') {
        const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : null
        if (!itemId) continue

        const existing = callByItemId.get(itemId)
        if (existing) {
          existing.arguments = parsed.arguments || existing.arguments
        } else {
          callByItemId.set(itemId, {
            id: itemId,
            name: '',
            arguments: parsed.arguments || '',
            seq: callSeq++,
          })
        }
        continue
      }

      if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
        const responseError = parsed?.response?.error
        const message =
          typeof responseError?.message === 'string' && responseError.message.trim().length > 0
            ? responseError.message
            : parsed.type === 'response.incomplete'
              ? 'OpenAI response was incomplete.'
              : 'OpenAI response failed.'
        throw new Error(message)
      }

      if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
        if (Array.isArray(parsed?.response?.output)) {
          completedOutputItems = parsed.response.output
        }
      }
    }
  }

  const normalizedCompletedOutputItems = normalizeResponseOutputItemsForReplay(completedOutputItems || [])
  const responseOutputItems =
    normalizedCompletedOutputItems.length > 0 ? normalizedCompletedOutputItems : buildFallbackResponseOutputItems()
  const text = selectFinalTextFromReplayItems(responseOutputItems, streamedText, useGPT53StrictTextAssembly)
  const reasoning = selectReasoningFromReplayItems(responseOutputItems, streamedReasoning)
  const toolCalls = extractToolCallsFromReplayItems(responseOutputItems)

  return {
    text,
    reasoning,
    toolCalls,
    responseOutputItems,
  }
}

export class OpenAiChatgptProvider implements HeadlessProvider {
  readonly name = 'openaichatgpt'
  private readonly tokenStore?: ProviderTokenStore

  constructor(deps: OpenAiChatgptProviderDeps = {}) {
    this.tokenStore = deps.tokenStore
  }

  private async resolveAuth(input: ProviderGenerateInput): Promise<ResolvedAuth> {
    if (input.accessToken) {
      const accountId = input.accountId || extractAccountId(input.accessToken)
      if (!accountId) {
        throw new Error(
          'ChatGPT account ID missing. Provide accountId or use a token that includes chatgpt_account_id claim.'
        )
      }
      return {
        accessToken: input.accessToken,
        accountId,
      }
    }

    if (this.tokenStore) {
      const record = input.userId
        ? this.tokenStore.get('openaichatgpt', input.userId)
        : this.tokenStore.getLatest('openaichatgpt')
      if (record) {
        if (shouldRefresh(record.expiresAt ?? null) && record.refreshToken) {
          const refreshed = await refreshOpenAiAccessToken(record.refreshToken)
          this.tokenStore.upsert({
            provider: 'openaichatgpt',
            userId: record.userId,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAtIso,
            accountId: refreshed.accountId,
          })

          return {
            accessToken: refreshed.accessToken,
            accountId: refreshed.accountId,
          }
        }

        const accountId = record.accountId || extractAccountId(record.accessToken)
        if (!accountId) {
          throw new Error('Stored OpenAI token is missing account context (chatgpt_account_id).')
        }

        return {
          accessToken: record.accessToken,
          accountId,
        }
      }
    }

    const envToken = process.env.OPENAI_CHATGPT_ACCESS_TOKEN || process.env.OPENAI_ACCESS_TOKEN || null
    const envAccountId = process.env.OPENAI_CHATGPT_ACCOUNT_ID || null

    if (envToken) {
      const derived = envAccountId || extractAccountId(envToken)
      if (!derived) {
        throw new Error('OPENAI_CHATGPT_ACCOUNT_ID is required when access token lacks chatgpt_account_id claim.')
      }
      return { accessToken: envToken, accountId: derived }
    }

    throw new Error(
      'OpenAI ChatGPT auth missing. Provide token+account_id or store OAuth tokens via provider-auth route.'
    )
  }

  async generate(input: ProviderGenerateInput, emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const traceId = createOpenAiChatgptTraceId(input)
    const startedAt = Date.now()
    logOpenAiChatgpt('info', 'generate start', {
      traceId,
      requestedModel: input.modelName,
      normalizedModel: normalizeModel(input.modelName),
      userId: input.userId,
      conversationId: input.railwayTurn?.conversationId,
      hasAccessTokenInput: Boolean(input.accessToken),
      hasAccountIdInput: Boolean(input.accountId),
      historyItems: Array.isArray(input.history) ? input.history.length : 0,
      toolDefinitions: Array.isArray(input.tools) ? input.tools.length : 0,
      hasUserContent: typeof input.userContent === 'string' && input.userContent.length > 0,
    })

    const auth = await this.resolveAuth(input)
    const model = normalizeModel(input.modelName)
    const sessionId = input.railwayTurn?.conversationId?.trim() || traceId
    const requestId = (input.railwayTurn as any)?.runId?.trim?.() || sessionId
    const messages = toCodexMessages(input)
    const codexProvider = new CodexResponsesProvider({ auth })
    const parsed = await codexProvider.generate({
      model,
      providerInput: input,
      messages,
      tools: input.tools || [],
      sessionId,
      runId: requestId,
      signal: input.signal,
      emit,
    })

    logOpenAiChatgpt('info', 'transport parsed output', {
      traceId,
      elapsedMs: Date.now() - startedAt,
      responseId: parsed.responseId,
      textLength: parsed.content.length,
      reasoningLength: parsed.reasoningContent?.length || 0,
      toolCalls: parsed.toolCalls.length,
      responseOutputItems: parsed.outputItems?.length || 0,
      usage: parsed.usage,
      requestMode: 'qubit_exact_full_replay',
    })

    logCodexUsage({
      model,
      responseId: parsed.responseId,
      promptCacheKey: parsed.promptCacheKey,
      promptCacheRetention: 'in_memory',
      requestMode: 'qubit_exact_full_replay',
      inputItems: parsed.diagnostics.inputItems,
      hasPreviousResponseId: false,
      usage: parsed.usage,
    })

    const responseOutputItems = parsed.outputItems || []
    const contentBlocks: any[] = []
    if (parsed.reasoningContent) contentBlocks.push({ type: 'thinking', content: parsed.reasoningContent })
    if (parsed.content) contentBlocks.push({ type: 'text', content: parsed.content })

    const imageBlocks = extractImageBlocksFromResponseItems(responseOutputItems)
    for (const imageBlock of imageBlocks) {
      contentBlocks.push(imageBlock)
      emit?.({ type: 'chunk', part: 'image', url: imageBlock.url, mimeType: imageBlock.mimeType })
    }

    for (const toolCall of parsed.toolCalls) {
      contentBlocks.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.arguments })
    }

    if (responseOutputItems.length > 0) {
      contentBlocks.push({ type: 'responses_output_items', items: responseOutputItems })
    }

    const output: ProviderGenerateOutput = {
      content: parsed.content,
      reasoning: parsed.reasoningContent || undefined,
      toolCalls: parsed.toolCalls,
      contentBlocks,
      raw: {
        responses_output_items: responseOutputItems,
        response_items_added: parsed.responseItemsAdded || [],
        response_id: parsed.responseId,
        request_mode: 'qubit_exact_full_replay',
        used_previous_response_id: null,
        used_incremental_tool_output: false,
        usage: parsed.usage,
        request_shape: parsed.diagnostics,
        generatedImagesDirectoryHint: getGeneratedImagesDirectoryHint(),
      },
    }

    logOpenAiChatgpt('info', 'generate finish', {
      traceId,
      elapsedMs: Date.now() - startedAt,
      contentLength: output.content.length,
      reasoningLength: output.reasoning?.length || 0,
      toolCalls: output.toolCalls?.length || 0,
      contentBlocks: output.contentBlocks?.length || 0,
      rawResponseId: output.raw?.response_id,
    })
    return output
  }
}
