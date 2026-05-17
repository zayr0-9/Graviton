import path from 'path'
import WebSocket from 'ws'
import {
  CHATGPT_BASE_URL,
  CHATGPT_CODEX_ENDPOINT,
  JWT_CLAIM_PATH,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_URL,
} from '../../openaiChatgptOAuth.js'
import type { ProviderTokenStore } from './tokenStore.js'
import { openStreamingWithPreFirstByteRetry } from './streamResilience.js'
import { createOpenAIHostedTools } from './openaiHostedTools.js'
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
        if (item?.type === 'text' && typeof item?.content === 'string') return { type: 'input_text' as const, text: item.content }
        if (item?.type === 'text' && typeof item?.text === 'string') return { type: 'input_text' as const, text: item.text }
        if (item?.type === 'input_text' && typeof item?.text === 'string') return { type: 'input_text' as const, text: item.text }
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
    attachment.dataUrl ||
    attachment.dataURL ||
    attachment.url ||
    attachment.image_url ||
    attachment.imageUrl ||
    null

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

    const mediaType = typeof part.mimeType === 'string' ? part.mimeType : typeof part.mime === 'string' ? part.mime : 'image/png'
    if (typeof part.data === 'string' && part.data.trim().length > 0 && mediaType.startsWith('image/')) {
      const trimmed = part.data.trim()
      if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed
      return `data:${mediaType};base64,${trimmed}`
    }
  }

  if (part.type === 'file') {
    const mediaType = typeof part.mediaType === 'string' ? part.mediaType : typeof part.mime === 'string' ? part.mime : ''
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
  return (
    (msg.role === 'system' || msg.role === 'developer') &&
    text.startsWith(AUTO_COMPACTION_SUMMARY_RESUME_LINE)
  )
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

function parseStoredResponseOutputItems(raw: any): any[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
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

function extractStoredResponseOutputItemsFromMessage(msg: any): any[] {
  const direct = normalizeResponseOutputItemsForReplay(parseStoredResponseOutputItems(msg?.responses_output_items))
  if (direct.length > 0) return direct

  const contentBlocks = parseContentBlocks(msg?.content_blocks)
  for (const block of contentBlocks) {
    if (block?.type === 'responses_output_items' && Array.isArray(block?.items)) {
      const fromBlock = normalizeResponseOutputItemsForReplay(block.items)
      if (fromBlock.length > 0) return fromBlock
    }
  }

  return []
}

function collectToolOutputCallIds(messages: any[]): Set<string> {
  const ids = new Set<string>()

  for (const msg of messages || []) {
    if (msg?.role === 'assistant' && msg?.content_blocks) {
      const contentBlocks = parseContentBlocks(msg.content_blocks)
      for (const block of contentBlocks) {
        if (block?.type !== 'tool_result') continue
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (callId) ids.add(callId)
      }
    }

    if (msg?.role === 'tool' && typeof msg?.tool_call_id === 'string' && msg.tool_call_id) {
      ids.add(msg.tool_call_id)
    }
  }

  return ids
}

function transformMessagesForCodex(history: any[], fallbackUserContent: string): any[] {
  const input: any[] = []
  const toolCallIds = new Set<string>()
  const toolOutputIds = new Set<string>()
  const availableToolOutputCallIds = collectToolOutputCallIds(history)
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
      const storedResponseItems = extractStoredResponseOutputItemsFromMessage(msg)
      let hasStoredFunctionCalls = false

      for (const item of storedResponseItems) {
        if (item?.type === 'reasoning') {
          input.push(item)
          continue
        }

        if (item?.type === 'image_generation_call') {
          if (typeof item.result === 'string' && item.result.trim().length > 0) {
            input.push(item)
          }
          continue
        }

        if (item?.type === 'function_call') {
          const callId = typeof item.call_id === 'string' ? item.call_id : ''
          if (!callId) continue
          if (!availableToolOutputCallIds.has(callId)) continue
          hasStoredFunctionCalls = true
          toolCallIds.add(callId)
          input.push(item)
        }
      }

      const assistantContent = toOutputTextContent(msg?.content)
      if (assistantContent.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: assistantContent })
      }

      if (!hasStoredFunctionCalls && Array.isArray(msg?.tool_calls)) {
        for (const toolCall of msg.tool_calls) {
          const callId = typeof toolCall?.id === 'string' ? toolCall.id : ''
          if (!callId) continue
          if (!availableToolOutputCallIds.has(callId)) continue

          const name = getToolCallName(toolCall)
          if (!name) continue

          const args =
            typeof toolCall?.arguments === 'string'
              ? toolCall.arguments
              : JSON.stringify(toolCall?.arguments ?? toolCall?.input ?? {})

          toolCallIds.add(callId)
          input.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: args,
          })
        }
      }

      const contentBlocks = parseContentBlocks(msg?.content_blocks)
      for (const block of contentBlocks) {
        if (block?.type !== 'tool_result') continue
        const callId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : ''
        if (!callId || toolOutputIds.has(callId) || !toolCallIds.has(callId)) continue

        const sanitized = sanitizeToolResultContentForModel(block.content, toolNameById.get(callId) || null)

        toolOutputIds.add(callId)
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: typeof sanitized === 'string' ? sanitized : sanitized ?? null,
        })
      }

      continue
    }

    if (msg?.role === 'tool' && msg?.tool_call_id) {
      const callId = String(msg.tool_call_id)
      if (toolOutputIds.has(callId)) continue
      if (!toolCallIds.has(callId)) continue

      const sanitized = sanitizeToolResultContentForModel(msg?.content, toolNameById.get(callId) || null)
      toolOutputIds.add(callId)
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: typeof sanitized === 'string' ? sanitized : sanitized ?? null,
      })
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
    .map(msg => (typeof msg?.content === 'string' ? msg.content : typeof msg?.content_plain_text === 'string' ? msg.content_plain_text : ''))
    .join('\n')}`

  return /\b(generate|create|make|draw|edit|render)\b[\s\S]{0,80}\b(image|picture|photo|illustration|icon|logo|sprite|asset)\b/i.test(text)
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

function selectFinalTextFromReplayItems(replayItems: any[], fallbackText: string, useGPT53StrictTextAssembly: boolean): string {
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

type CodexParsedOutput = {
  text: string
  reasoning: string
  toolCalls: ProviderToolCall[]
  responseOutputItems: any[]
}

function createCodexEventParser(params: { emit?: ProviderStreamEventHandler; modelName: string }) {
  const { emit, modelName } = params
  const useGPT53StrictTextAssembly = shouldUseGPT53StrictTextAssembly(modelName)
  let streamedText = ''
  let streamedReasoning = ''
  let completedOutputItems: any[] | null = null
  const callByItemId = new Map<string, { id: string; name: string; arguments: string; outputIndex?: number; seq: number }>()
  const responseOutputItemsById = new Map<string, { id: string; type?: string; role?: string; phase?: string; outputIndex?: number; seq: number }>()
  const responseTextByItem = new Map<string, { text: string; outputIndex?: number; seq: number; fromDone: boolean }>()
  const imageGenerationItemsById = new Map<string, any>()
  const reasoningByKey = new Map<string, string>()
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
    const outputIndex = typeof item.output_index === 'number' ? item.output_index : typeof item.outputIndex === 'number' ? item.outputIndex : existing?.outputIndex
    responseOutputItemsById.set(item.id, { id: item.id, type: typeof item.type === 'string' ? item.type : existing?.type, role: typeof item.role === 'string' ? item.role : existing?.role, phase: typeof item.phase === 'string' ? item.phase : existing?.phase, outputIndex, seq: existing?.seq ?? responseSeq++ })
  }
  const upsertResponseText = (itemId: string, text: string, outputIndex?: number, fromDone: boolean = false) => {
    const existing = responseTextByItem.get(itemId)
    responseTextByItem.set(itemId, { text: fromDone ? text : (existing?.text || '') + text, outputIndex: typeof outputIndex === 'number' ? outputIndex : existing?.outputIndex, seq: existing?.seq ?? responseSeq++, fromDone: fromDone || Boolean(existing?.fromDone) })
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
    if (Array.isArray(item.content)) item.content.forEach((part: any, i: number) => { if (part?.type === 'reasoning_text' && typeof part.text === 'string') applyReasoningDone(`reasoning_text:${itemId}:${i}`, part.text) })
    if (Array.isArray(item.summary)) item.summary.forEach((part: any, i: number) => { if (typeof part?.text === 'string') applyReasoningDone(`reasoning_summary:${itemId}:${i}`, part.text) })
  }
  const buildFallbackResponseOutputItems = (): any[] => {
    const fallbackMessages = Array.from(responseOutputItemsById.values()).filter(item => (!item.type || item.type === 'message') && (!item.role || item.role === 'assistant')).sort((a, b) => (typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number') ? a.outputIndex - b.outputIndex : typeof a.outputIndex === 'number' ? -1 : typeof b.outputIndex === 'number' ? 1 : a.seq - b.seq).map(item => {
      const text = responseTextByItem.get(item.id)?.text || ''
      if (!text.trim()) return null
      return { type: 'message', id: item.id, role: item.role || 'assistant', phase: item.phase, output_index: item.outputIndex, content: [{ type: 'output_text', text }] }
    }).filter(Boolean)
    const fallbackFunctionCalls = Array.from(callByItemId.values()).sort((a, b) => (typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number') ? a.outputIndex - b.outputIndex : typeof a.outputIndex === 'number' ? -1 : typeof b.outputIndex === 'number' ? 1 : a.seq - b.seq).map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments || '', output_index: call.outputIndex })).filter(call => call.call_id && call.name)
    const fallbackImages = Array.from(imageGenerationItemsById.values())
    return normalizeResponseOutputItemsForReplay([...fallbackMessages, ...fallbackFunctionCalls, ...fallbackImages])
  }
  const handle = (parsed: any) => {
    if (!parsed) return
    if (parsed.type === 'response.output_item.added' || parsed.type === 'response.output_item.done') {
      const item = parsed.item
      mergeOutputItem(item)
      if (item?.type === 'function_call' && item?.id) {
        const existing = callByItemId.get(item.id)
        const outputIndex = typeof item.output_index === 'number' ? item.output_index : typeof item.outputIndex === 'number' ? item.outputIndex : existing?.outputIndex
        if (existing) { existing.id = item.call_id || item.id; existing.name = item.name || existing.name; existing.arguments = item.arguments ?? existing.arguments; existing.outputIndex = outputIndex }
        else callByItemId.set(item.id, { id: item.call_id || item.id, name: item.name || '', arguments: item.arguments || '', outputIndex, seq: callSeq++ })
      }
      if (item?.type === 'image_generation_call' && item?.id) {
        imageGenerationItemsById.set(item.id, item)
        console.log('[OpenAI ChatGPT] image_generation_call output item', {
          eventType: parsed.type,
          id: item.id,
          status: item.status,
          hasResult: typeof item.result === 'string' && item.result.trim().length > 0,
          resultLength: typeof item.result === 'string' ? item.result.length : 0,
        })
      }
      if (parsed.type === 'response.output_item.done') {
        if (item?.type === 'message' && item?.id) {
          const text = extractAssistantMessageTextFromReplayItem({ type: 'message', content: normalizeResponseMessageContent(item.content) })
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
      if (shouldEmitTextForEvent(parsed)) { streamedText += delta; emit?.({ type: 'chunk', part: 'text', delta }) }
      return
    }
    if (parsed.type === 'response.output_text.done') {
      const itemId = extractItemId(parsed)
      if (itemId && typeof parsed.text === 'string') upsertResponseText(itemId, parsed.text, extractIndex(parsed, 'output_index', 'outputIndex'), true)
      return
    }
    if (parsed.type === 'response.reasoning_text.delta' && typeof parsed.delta === 'string') { const itemId = extractItemId(parsed) || 'reasoning'; applyReasoningDelta(`reasoning_text:${itemId}:${extractIndex(parsed, 'content_index', 'contentIndex') || 0}`, parsed.delta); return }
    if (parsed.type === 'response.reasoning_summary_text.delta' && typeof parsed.delta === 'string') { const itemId = extractItemId(parsed) || 'reasoning'; applyReasoningDelta(`reasoning_summary:${itemId}:${extractIndex(parsed, 'summary_index', 'summaryIndex') || 0}`, parsed.delta); return }
    if (parsed.type === 'response.function_call_arguments.delta') { const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : null; if (!itemId) return; const existing = callByItemId.get(itemId); if (existing) existing.arguments += parsed.delta || ''; else callByItemId.set(itemId, { id: itemId, name: '', arguments: parsed.delta || '', seq: callSeq++ }); return }
    if (parsed.type === 'response.function_call_arguments.done') { const itemId = typeof parsed.item_id === 'string' ? parsed.item_id : null; if (!itemId) return; const existing = callByItemId.get(itemId); if (existing) existing.arguments = parsed.arguments || existing.arguments; else callByItemId.set(itemId, { id: itemId, name: '', arguments: parsed.arguments || '', seq: callSeq++ }); return }
    if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') { const responseError = parsed?.response?.error; throw new Error(typeof responseError?.message === 'string' && responseError.message.trim() ? responseError.message : parsed.type === 'response.incomplete' ? 'OpenAI response was incomplete.' : 'OpenAI response failed.') }
    if (parsed.type === 'error') { const err = parsed.error; throw new Error(typeof err?.message === 'string' ? err.message : 'OpenAI websocket returned an error event.') }
    if ((parsed.type === 'response.completed' || parsed.type === 'response.done') && Array.isArray(parsed?.response?.output)) completedOutputItems = parsed.response.output
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
    console.log('[OpenAI ChatGPT] response output summary', {
      completedOutputCount: completedOutputItems?.length || 0,
      normalizedOutputTypes: responseOutputItems.map((item: any) => item?.type).filter(Boolean),
      imageGenerationCount: responseOutputItems.filter((item: any) => item?.type === 'image_generation_call').length,
    })
    return { text: selectFinalTextFromReplayItems(responseOutputItems, streamedText, useGPT53StrictTextAssembly), reasoning: selectReasoningFromReplayItems(responseOutputItems, streamedReasoning), toolCalls: extractToolCallsFromReplayItems(responseOutputItems), responseOutputItems }
  }
  return { handle, finish }
}

async function readCodexSseOutput(params: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  firstRead?: ReadableStreamReadResult<Uint8Array> | null
  emit?: ProviderStreamEventHandler
  modelName: string
}): Promise<CodexParsedOutput> {
/* legacy parser body retained but bypassed below */
  const parser = createCodexEventParser({ emit: params.emit, modelName: params.modelName })
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingRead: ReadableStreamReadResult<Uint8Array> | null = params.firstRead ?? null
  while (true) {
    const readResult = pendingRead ?? (await params.reader.read())
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
      try { parser.handle(JSON.parse(payload)) } catch (error) { if (error instanceof SyntaxError) continue; throw error }
    }
  }
  return parser.finish()
}

async function readCodexWebSocketOutput(params: { endpoint: string; headers: Record<string, string>; body: any; emit?: ProviderStreamEventHandler; modelName: string; timeoutMs?: number }): Promise<CodexParsedOutput> {
  const parser = createCodexEventParser({ emit: params.emit, modelName: params.modelName })
  const wsEndpoint = params.endpoint.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
  return await new Promise<CodexParsedOutput>((resolve, reject) => {
    let settled = false
    let completed = false
    const ws = new WebSocket(wsEndpoint, { headers: params.headers, perMessageDeflate: true })
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(parser.finish())
    }
    const fail = (error: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const timer = setTimeout(() => fail(new Error('OpenAI websocket idle timeout')), params.timeoutMs ?? 120000)
    const bumpTimer = () => { timer.refresh?.() }
    ws.on('open', () => {
      bumpTimer()
      ws.send(JSON.stringify({ type: 'response.create', ...params.body }), err => { if (err) fail(err) })
    })
    ws.on('message', data => {
      bumpTimer()
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : data.toString()
      try {
        const parsed = JSON.parse(text)
        parser.handle(parsed)
        if (parsed?.type === 'response.completed' || parsed?.type === 'response.done') {
          completed = true
          finish()
        }
      } catch (error) {
        fail(error)
      }
    })
    ws.on('error', fail)
    ws.on('close', (_code, reason) => {
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
        applyReasoningDelta(`reasoning_text:${itemId}:${extractIndex(parsed, 'content_index', 'contentIndex') || 0}`, parsed.delta)
        continue
      }

      if (parsed.type === 'response.reasoning_summary_text.delta' && typeof parsed.delta === 'string') {
        const itemId = extractItemId(parsed) || 'reasoning'
        applyReasoningDelta(`reasoning_summary:${itemId}:${extractIndex(parsed, 'summary_index', 'summaryIndex') || 0}`, parsed.delta)
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
        throw new Error('ChatGPT account ID missing. Provide accountId or use a token that includes chatgpt_account_id claim.')
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

    throw new Error('OpenAI ChatGPT auth missing. Provide token+account_id or store OAuth tokens via provider-auth route.')
  }

  async generate(input: ProviderGenerateInput, emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const auth = await this.resolveAuth(input)

    const hostedTools = createOpenAIHostedTools({
      config: input.railwayTurn?.openaiHostedTools,
      enableImageGeneration: hasImageGenerationIntent(input),
    })
    const requestTools = [...mapTools(input.tools || []), ...hostedTools]
    console.log('[OpenAI ChatGPT] request setup', {
      model: normalizeModel(input.modelName),
      hostedTools: hostedTools.map((tool: any) => tool?.type).filter(Boolean),
      functionToolCount: (input.tools || []).length,
      totalToolCount: requestTools.length,
      imageIntent: hasImageGenerationIntent(input),
      imageConfig: input.railwayTurn?.imageConfig,
    })
    const transformedInput = appendImageAttachmentsToLatestUserMessage(
      transformMessagesForCodex(input.history || [], input.userContent),
      input.railwayTurn?.attachmentsBase64 ?? null
    )
    console.log('[OpenAI ChatGPT] transformed input summary', {
      itemCount: transformedInput.length,
      itemTypes: transformedInput.map((item: any) => item?.type).filter(Boolean),
      imageGenerationCount: transformedInput.filter((item: any) => item?.type === 'image_generation_call').length,
      imageGenerationResultLengths: transformedInput
        .filter((item: any) => item?.type === 'image_generation_call')
        .map((item: any) => (typeof item.result === 'string' ? item.result.length : 0)),
      hasGeneratedImagePathHint: transformedInput.some(
        (item: any) => item?.type === 'message' && item?.role === 'developer' && JSON.stringify(item?.content || '').includes('generated_images')
      ),
    })
    const requestBody = {
      model: normalizeModel(input.modelName),
      instructions: input.systemPrompt && input.systemPrompt.trim() ? input.systemPrompt : 'You are ChatGPT.',
      input: transformedInput,
      tools: requestTools.length ? requestTools : undefined,
      tool_choice: requestTools.length ? 'auto' : undefined,
      parallel_tool_calls: requestTools.length ? true : undefined,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: {
        effort: 'medium',
        summary: 'auto',
      },
      stream: true,
    }


    const endpoint = `${CHATGPT_BASE_URL}${CHATGPT_CODEX_ENDPOINT}`
    let parsed: CodexParsedOutput

    try {
      parsed = await readCodexWebSocketOutput({
        endpoint,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'chatgpt-account-id': auth.accountId,
          'OpenAI-Beta': 'responses_websockets=2026-02-06',
          originator: 'opencode',
          'x-client-request-id': input.railwayTurn?.conversationId || 'ygg-chat',
        },
        body: requestBody,
        emit,
        modelName: input.modelName,
      })
    } catch (websocketError) {
      console.warn('[OpenAI ChatGPT] WebSocket transport failed; falling back to HTTP/SSE:', websocketError)
      const streamOpen = await openStreamingWithPreFirstByteRetry({
        endpoint,
        openAttempt: signal =>
          fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${auth.accessToken}`,
              'chatgpt-account-id': auth.accountId,
              'OpenAI-Beta': 'responses=experimental',
              originator: 'opencode',
              accept: 'text/event-stream',
            },
            body: JSON.stringify(requestBody),
            signal,
          }),
      })

      if (!streamOpen.response.ok) {
        const text = await streamOpen.response.text().catch(() => '')
        throw new Error(`ChatGPT backend request failed (${streamOpen.response.status}): ${text}`)
      }

      if (!streamOpen.reader) {
        throw new Error('ChatGPT backend returned no readable stream body')
      }

      parsed = await readCodexSseOutput({
        reader: streamOpen.reader,
        firstRead: streamOpen.firstRead,
        emit,
        modelName: input.modelName,
      })
    }
    const contentBlocks: any[] = []
    console.log('[OpenAI ChatGPT] parsed result summary', {
      textLength: parsed.text?.length || 0,
      reasoningLength: parsed.reasoning?.length || 0,
      toolCallCount: parsed.toolCalls?.length || 0,
      responseOutputTypes: parsed.responseOutputItems.map((item: any) => item?.type).filter(Boolean),
      imageGenerationCount: parsed.responseOutputItems.filter((item: any) => item?.type === 'image_generation_call').length,
    })

    if (parsed.reasoning) {
      contentBlocks.push({ type: 'thinking', content: parsed.reasoning })
    }

    if (parsed.text) {
      contentBlocks.push({ type: 'text', content: parsed.text })
    }

    const imageBlocks = extractImageBlocksFromResponseItems(parsed.responseOutputItems)
    console.log('[OpenAI ChatGPT] normalized image blocks', {
      count: imageBlocks.length,
      mimeTypes: imageBlocks.map(block => block.mimeType),
      urlLengths: imageBlocks.map(block => (typeof block.url === 'string' ? block.url.length : 0)),
    })
    for (const imageBlock of imageBlocks) {
      contentBlocks.push(imageBlock)
      emit?.({ type: 'chunk', part: 'image', url: imageBlock.url, mimeType: imageBlock.mimeType })
    }

    for (const toolCall of parsed.toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments,
      })
    }

    if (parsed.responseOutputItems.length > 0) {
      contentBlocks.push({
        type: 'responses_output_items',
        items: parsed.responseOutputItems,
      })
    }

    return {
      content: parsed.text,
      reasoning: parsed.reasoning || undefined,
      toolCalls: parsed.toolCalls,
      contentBlocks,
      raw: {
        responses_output_items: parsed.responseOutputItems,
        generatedImagesDirectoryHint: getGeneratedImagesDirectoryHint(),
      },
    }
  }
}
