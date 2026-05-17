// OpenAI ChatGPT Streaming Adapter
// Uses ChatGPT backend API with OAuth tokens from user's Plus/Pro subscription
// Runs locally only (Electron mode) for TOS compliance

import { v4 as uuidv4 } from 'uuid'
import { ConversationId, MessageId, ToolDefinition as SharedToolDefinition } from '../../../../../shared/types'
import { ContentBlock, Message, ToolCall } from './chatTypes'
import { CHATGPT_BASE_URL, CHATGPT_CODEX_ENDPOINT, getValidTokens } from './openaiOAuth'
import { openStreamingWithPreFirstByteRetry } from './streamResilience'
import { getToolsForAI } from './toolDefinitions'

const AUTO_COMPACTION_NOTE = '__auto_compaction_summary__'
const AUTO_COMPACTION_SUMMARY_RESUME_LINE = 'Following is summary of the session, you have to resume the work.'
const GENERATED_IMAGE_PATH_HINT_NOTE = '__generated_image_path_hint__'

function isAutoCompactionSummaryMessage(msg: any): boolean {
  if (!msg) return false
  if (msg.note === AUTO_COMPACTION_NOTE) return true

  const content =
    typeof msg.content === 'string'
      ? msg.content
      : typeof msg.content_plain_text === 'string'
        ? msg.content_plain_text
        : ''

  return msg.role === 'system' && content.trim().startsWith(AUTO_COMPACTION_SUMMARY_RESUME_LINE)
}

function isGeneratedImagePathHintMessage(msg: any): boolean {
  return Boolean(msg && msg.note === GENERATED_IMAGE_PATH_HINT_NOTE)
}

// Map internal ToolDefinition -> OpenAI tool schema
function mapTools(tools: SharedToolDefinition[]) {
  return tools
    .filter(t => t.enabled)
    .map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || { type: 'object', properties: {} },
    }))
}

// Normalize model names to what ChatGPT backend expects
function normalizeModel(model: string): string {
  const m = model.toLowerCase().replace(/\s+/g, '-')

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

// Get reasoning configuration based on model
function getReasoningConfig(model: string) {
  const normalized = normalizeModel(model)

  // Codex models default to medium reasoning
  if (normalized.includes('codex')) {
    return {
      effort: 'medium',
      summary: 'auto',
    }
  }

  return {
    effort: 'medium',
    summary: 'auto',
  }
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

  // If the visible prefix still looks like planner scratchpad text, drop it.
  if (prefix.length < 600 && /\b(need|inspect|gather|tool|maybe|let'?s)\b/i.test(prefix)) {
    return ''
  }

  return prefix
}

// Types for streaming
interface ChatGPTDeltaToolCall {
  index?: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

interface ChatGPTStreamChunk {
  choices?: Array<{ delta?: any; message?: any; finish_reason?: string | null }>
  id?: string
  type?: string
}

interface ChatGPTResponseOutputItem {
  id?: string
  type?: string
  role?: string
  phase?: string
  status?: string
  arguments?: string
  call_id?: string
  name?: string
  output_index?: number
  outputIndex?: number
  result?: string
  revised_prompt?: string
  summary?: Array<{
    type?: string
    text?: string
  }>
  content?: Array<{
    type?: string
    text?: string
  }>
}

// Accumulator for incremental tool call building
interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
}

// Process incremental tool call deltas and accumulate them
function processToolCallDeltas(
  deltaToolCalls: ChatGPTDeltaToolCall[],
  accumulators: Map<number, ToolCallAccumulator>
): { newToolCalls: ToolCall[]; updatedIndices: number[] } {
  const newToolCalls: ToolCall[] = []
  const updatedIndices: number[] = []

  for (const tc of deltaToolCalls || []) {
    const index = tc.index ?? 0

    if (!accumulators.has(index)) {
      const id = tc.id || uuidv4()
      const name = tc.function?.name || ''
      const args = tc.function?.arguments || ''
      accumulators.set(index, { id, name, arguments: args })

      if (name) {
        newToolCalls.push({ id, name, arguments: args, status: 'pending' })
      }
    } else {
      const acc = accumulators.get(index)!
      if (tc.id) acc.id = tc.id
      if (tc.function?.name) acc.name = tc.function.name
      if (tc.function?.arguments) {
        acc.arguments += tc.function.arguments
      }
      updatedIndices.push(index)
    }
  }

  return { newToolCalls, updatedIndices }
}

// Build final Message from accumulated parts
function buildAssistantMessage(params: {
  id: string
  conversationId: ConversationId
  parentId: MessageId | null
  modelName: string
  text: string
  toolCalls: ToolCall[]
  contentBlocks: ContentBlock[]
  partial?: boolean
}): Message {
  const { id, conversationId, parentId, modelName, text, toolCalls, contentBlocks, partial = false } = params
  return {
    id,
    conversation_id: conversationId,
    parent_id: parentId,
    children_ids: [],
    role: 'assistant',
    content: text,
    content_plain_text: text,
    thinking_block: '',
    tool_calls: toolCalls,
    model_name: modelName,
    partial,
    created_at: new Date().toISOString(),
    artifacts: [],
    pastedContext: [],
    content_blocks: contentBlocks,
  }
}

export interface OpenAIChatGPTStreamHandlers {
  onChunk: (chunk: any) => void
  signal?: AbortSignal
}

export interface OpenAIChatGPTRequestPayload {
  conversationId: ConversationId
  parentId: MessageId | null
  modelName: string
  systemPrompt: string
  messages: any[] // OpenAI-like messages
  attachmentsBase64?: any[] | null
  selectedFiles?: any[] | null
  think?: boolean
  imageConfig?: any
  reasoningConfig?: any
  tools?: SharedToolDefinition[]
}

function toInputTextContent(content: any): Array<{ type: 'input_text'; text: string }> {
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') {
          return { type: 'input_text', text: item }
        }
        if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
          return { type: 'input_text', text: item.text }
        }
        return item
      })
      .filter(item => item && typeof item.text === 'string')
  }
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }]
  }
  if (content == null) {
    return []
  }
  return [{ type: 'input_text', text: String(content) }]
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

  if (part.type === 'file') {
    const mediaType = typeof part.mediaType === 'string' ? part.mediaType : typeof part.mime === 'string' ? part.mime : ''
    if (mediaType && mediaType.startsWith('image/')) {
      const direct = normalizeAttachmentImageUrl(part.url || part.dataUrl || part.image_url || null)
      if (direct) return direct

      if (typeof part.data === 'string' && part.data.trim().length > 0) {
        const trimmed = part.data.trim()
        if (/^data:image\//i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
          return trimmed
        }
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
    for (const part of msg.content) {
      addFromPart(part)
    }
  }

  const artifacts = Array.isArray(msg?.artifacts) ? msg.artifacts : []
  for (const artifact of artifacts) {
    add(artifact)
  }

  const attachments = Array.isArray(msg?.attachments) ? msg.attachments : []
  for (const attachment of attachments) {
    add(attachment)
  }

  const contentBlocks = parseContentBlocks(msg?.content_blocks)
  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue
    addFromPart(block)
    add(block.image_url)
    add(block.imageUrl)
    add(block.url)
    add(block.dataUrl)

    if (Array.isArray(block.content)) {
      for (const part of block.content) {
        addFromPart(part)
      }
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

        const imageUrl = extractImageUrlFromContentPart(item)
        if (imageUrl) {
          contentParts.push({ type: 'input_image', image_url: imageUrl })
        }
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

  return contentParts
}

function toOutputTextContent(content: any): Array<{ type: 'output_text'; text: string }> {
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') {
          return { type: 'output_text', text: item }
        }
        if (item && typeof item === 'object' && item.type === 'input_text' && typeof item.text === 'string') {
          return { type: 'output_text', text: item.text }
        }
        return item
      })
      .filter(item => item && typeof item.text === 'string' && item.text.trim().length > 0)
  }
  if (typeof content === 'string') {
    if (content.trim().length === 0) return []
    return [{ type: 'output_text', text: content }]
  }
  if (content == null) {
    return []
  }
  return [{ type: 'output_text', text: String(content) }]
}

function parseContentBlocks(blocks: any): any[] {
  if (!blocks) return []
  if (Array.isArray(blocks)) return blocks
  if (typeof blocks === 'string') {
    try {
      return JSON.parse(blocks)
    } catch {
      return []
    }
  }
  return []
}

function getToolCallNameAndArgs(tc: any): { name: string; args: any } {
  const name = typeof tc?.name === 'string' ? tc.name : typeof tc?.function?.name === 'string' ? tc.function.name : ''
  const args =
    tc?.arguments !== undefined
      ? tc.arguments
      : tc?.function?.arguments !== undefined
        ? tc.function.arguments
        : undefined
  return { name, args }
}

function collectToolOutputCallIds(messages: any[]): Set<string> {
  const ids = new Set<string>()

  for (const msg of messages) {
    // Tool outputs encoded in assistant content_blocks (tool_result entries)
    if (msg?.role === 'assistant' && msg?.content_blocks) {
      const contentBlocks = parseContentBlocks(msg.content_blocks)
      for (const block of contentBlocks) {
        if (block?.type !== 'tool_result') continue
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (callId) ids.add(callId)
      }
    }

    // Tool outputs encoded as explicit tool-role messages
    if (msg?.role === 'tool' && typeof msg?.tool_call_id === 'string' && msg.tool_call_id) {
      ids.add(msg.tool_call_id)
    }
  }

  return ids
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
        return { type: 'output_text', text: part.text }
      }
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
        return { type: 'output_text', text: part.text }
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

// Transform messages to ChatGPT backend (responses API) format
function transformMessagesForChatGPT(messages: any[]): any[] {
  const input: any[] = []
  const toolCallIds = new Set<string>()
  const toolOutputIds = new Set<string>()
  const availableToolOutputCallIds = collectToolOutputCallIds(messages)

  // Transform each message
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (isAutoCompactionSummaryMessage(msg) || isGeneratedImagePathHintMessage(msg)) {
        const developerContent = toUserInputContent(msg)
        if (developerContent.length > 0) {
          input.push({
            type: 'message',
            role: 'developer',
            content: developerContent,
          })
        }
      }

      // Regular system prompts are sent via instructions for the Codex backend.
      // Auto-compaction summaries are persisted as system messages too, but they are
      // branch history and must remain model-visible after compaction.
      continue
    } else if (msg.role === 'developer') {
      const developerContent = toUserInputContent(msg)
      if (developerContent.length === 0) {
        continue
      }

      input.push({
        type: 'message',
        role: 'developer',
        content: developerContent,
      })
    } else if (msg.role === 'user') {
      const userContent = toUserInputContent(msg)
      if (userContent.length === 0) {
        continue
      }

      input.push({
        type: 'message',
        role: 'user',
        content: userContent,
      })
    } else if (msg.role === 'assistant') {
      const storedResponseItems = extractStoredResponseOutputItemsFromMessage(msg)
      let hasStoredFunctionCalls = false
      let hasStoredAssistantMessages = false

      for (const item of storedResponseItems) {
        if (item?.type === 'message' && item?.role === 'assistant' && Array.isArray(item?.content) && item.content.length > 0) {
          hasStoredAssistantMessages = true
          input.push(item)
          continue
        }

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

          // Guard: Responses API rejects histories where a function_call has no corresponding output.
          if (!availableToolOutputCallIds.has(callId)) {
            console.warn('[OpenAI ChatGPT] Dropping stored function_call without output:', callId)
            continue
          }

          hasStoredFunctionCalls = true
          toolCallIds.add(callId)
          input.push(item)
        }
      }

      if (!hasStoredAssistantMessages) {
        const content = toOutputTextContent(msg.content || '')
        if (content.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            content,
          })
        }
      }

      if (!hasStoredFunctionCalls && msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const callId = typeof tc?.id === 'string' ? tc.id : ''
          if (!callId) {
            console.warn('[OpenAI ChatGPT] Skipping tool call without id:', tc)
            continue
          }

          // Guard: Responses API rejects histories where a function_call has no corresponding output.
          // If we don't have tool output for this call id in history, omit the call entirely.
          if (!availableToolOutputCallIds.has(callId)) {
            console.warn('[OpenAI ChatGPT] Dropping tool call without output:', callId)
            continue
          }

          const { name, args } = getToolCallNameAndArgs(tc)
          if (!name) {
            console.warn('[OpenAI ChatGPT] Skipping tool call without name:', tc)
            continue
          }
          const serializedArgs = typeof args === 'string' ? args : JSON.stringify(args || {})
          toolCallIds.add(callId)
          input.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: serializedArgs,
          })
        }
      }

      const contentBlocks = parseContentBlocks(msg.content_blocks)
      for (const block of contentBlocks) {
        if (block?.type !== 'tool_result') continue
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
        if (!callId || toolOutputIds.has(callId)) continue
        if (!toolCallIds.has(callId)) continue
        toolOutputIds.add(callId)
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        })
      }
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      if (toolOutputIds.has(msg.tool_call_id)) {
        continue
      }
      if (!toolCallIds.has(msg.tool_call_id)) {
        continue
      }
      toolOutputIds.add(msg.tool_call_id)
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      })
    }
  }

  return input
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

function appendImageAttachmentsToLatestUserMessage(input: any[], attachmentsBase64?: any[] | null): any[] {
  if (!Array.isArray(attachmentsBase64) || attachmentsBase64.length === 0) {
    return input
  }

  const imageParts = attachmentsBase64
    .map(attachment => normalizeAttachmentImageUrl(attachment))
    .filter((url): url is string => Boolean(url))
    .map(url => ({ type: 'input_image', image_url: url }))

  if (imageParts.length === 0) {
    return input
  }

  // Target the latest user message in the transformed responses input
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
      }
    }

    target.content = existingContent
  } else {
    input.push({
      type: 'message',
      role: 'user',
      content: imageParts,
    })
  }

  return input
}

// Build request body for ChatGPT Codex backend
function buildCodexRequestBody(
  model: string,
  input: any[],
  tools: any[],
  instructions: string,
  reasoningConfig?: { effort?: string; summary?: string },
  thinkEnabled: boolean = true
) {
  const normalizedModel = normalizeModel(model)
  const reasoning = thinkEnabled ? reasoningConfig || getReasoningConfig(model) : undefined

  return {
    model: normalizedModel,
    instructions: instructions && instructions.trim() ? instructions : 'You are ChatGPT.',
    input,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    parallel_tool_calls: tools.length > 0 ? true : undefined,
    // Required for stateless operation with ChatGPT backend
    store: false,
    include: reasoning ? ['reasoning.encrypted_content'] : undefined,
    reasoning: reasoning
      ? {
          effort: reasoning.effort || 'medium',
          summary: reasoning.summary || 'auto',
        }
      : undefined,
    // Stream mode
    stream: true,
  }
}

export async function createOpenAIChatGPTStreamingRequest(
  payload: OpenAIChatGPTRequestPayload,
  handlers: OpenAIChatGPTStreamHandlers
) {
  const { onChunk, signal } = handlers

  if (typeof window !== 'undefined' && window.electronAPI?.openaiChatGPT?.streamStart) {
    const assistantMessageId = uuidv4()
    if (signal?.aborted) return
    onChunk({ type: 'generation_started', messageId: assistantMessageId })
    const started = await window.electronAPI.openaiChatGPT.streamStart({ ...payload, assistantMessageId })
    if (!started?.success || !started.streamId) {
      throw new Error(started?.error || 'Failed to start Electron OpenAI ChatGPT stream')
    }
    let cleanup: (() => void) | null = null
    let streamedText = ''
    let streamedReasoning = ''
    const streamedToolCalls = new Map<string, any>()
    let completed = false

    const emitPartialComplete = () => {
      if (completed) return false
      const hasContent = streamedText.trim().length > 0 || streamedReasoning.trim().length > 0 || streamedToolCalls.size > 0
      if (!hasContent) return false

      const contentBlocks: any[] = []
      if (streamedReasoning) contentBlocks.push({ type: 'thinking', index: contentBlocks.length, content: streamedReasoning })
      if (streamedText) contentBlocks.push({ type: 'text', index: contentBlocks.length, content: streamedText })
      for (const toolCall of streamedToolCalls.values()) {
        contentBlocks.push({
          type: 'tool_use',
          index: contentBlocks.length,
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments ?? {},
        })
      }

      completed = true
      onChunk({
        type: 'complete',
        message: buildAssistantMessage({
          id: assistantMessageId,
          conversationId: payload.conversationId,
          parentId: payload.parentId,
          modelName: payload.modelName,
          text: streamedText,
          toolCalls: Array.from(streamedToolCalls.values()),
          contentBlocks,
          partial: true,
        }),
      })
      return true
    }

    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        emitPartialComplete()
        void window.electronAPI?.openaiChatGPT?.streamAbort(started.streamId!)
        cleanup?.()
        resolve()
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      cleanup = window.electronAPI!.openaiChatGPT.onStreamEvent(({ streamId, chunk }) => {
        if (streamId !== started.streamId) return
        if (signal?.aborted) return
        if (chunk?.type === 'error') {
          cleanup?.()
          reject(new Error(chunk.error || 'OpenAI ChatGPT stream failed'))
          return
        }
        if (chunk?.type === 'chunk') {
          if (chunk.part === 'reasoning') {
            streamedReasoning += chunk.delta ?? chunk.content ?? ''
          } else if (chunk.part === 'tool_call' && chunk.toolCall?.id) {
            streamedToolCalls.set(chunk.toolCall.id, chunk.toolCall)
          } else if (!chunk.part || chunk.part === 'text') {
            streamedText += chunk.delta ?? chunk.content ?? ''
          }
        } else if (chunk?.type === 'tool_call' && chunk.toolCall?.id) {
          streamedToolCalls.set(chunk.toolCall.id, chunk.toolCall)
        }
        onChunk(chunk)
        if (chunk?.type === 'complete') {
          completed = true
          cleanup?.()
          resolve()
        }
      })
    })
    return
  }

  // Get valid tokens (refreshes if needed)
  const tokens = await getValidTokens()
  if (!tokens) {
    throw new Error('OpenAI authentication required. Please sign in with your ChatGPT Plus/Pro account.')
  }

  // Get tools
  const allTools = payload.tools || getToolsForAI()
  const tools = mapTools(allTools)

  // Transform messages to ChatGPT format
  const input = transformMessagesForChatGPT(payload.messages)

  // Attach image inputs (if provided) to the latest user message for multimodal models
  const inputWithImages = appendImageAttachmentsToLatestUserMessage(input, payload.attachmentsBase64)
  // if (Array.isArray(payload.attachmentsBase64) && payload.attachmentsBase64.length > 0) {
  //   console.log('[OpenAI ChatGPT] Image attachments provided:', payload.attachmentsBase64.length)
  // }

  // Build request body - use system prompt as instructions
  const body = buildCodexRequestBody(
    payload.modelName,
    inputWithImages,
    tools,
    payload.systemPrompt || '',
    payload.reasoningConfig,
    payload.think !== false
  )

  // Build URL for Codex endpoint
  const url = `${CHATGPT_BASE_URL}${CHATGPT_CODEX_ENDPOINT}`

  let streamOpen: Awaited<ReturnType<typeof openStreamingWithPreFirstByteRetry>>
  try {
    streamOpen = await openStreamingWithPreFirstByteRetry({
      endpoint: url,
      conversationId: String(payload.conversationId),
      parentSignal: signal,
      openAttempt: attemptSignal =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokens.accessToken}`,
            'chatgpt-account-id': tokens.accountId,
            'OpenAI-Beta': 'responses=experimental',
            originator: 'opencode',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          signal: attemptSignal,
        }),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw e
    }
    throw new Error(`ChatGPT API not reachable: ${e instanceof Error ? e.message : String(e)}`)
  }

  const res = streamOpen.response
  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    console.error('[OpenAI ChatGPT] Request failed:', res.status, errorText)

    // Handle usage limits
    if (res.status === 404 || res.status === 429) {
      const lower = errorText.toLowerCase()
      if (lower.includes('usage_limit') || lower.includes('rate_limit')) {
        throw new Error('ChatGPT usage limit reached. Please try again later or check your subscription.')
      }
    }

    throw new Error(`ChatGPT request failed: HTTP ${res.status}`)
  }

  const reader = streamOpen.reader
  if (!reader) {
    throw new Error('ChatGPT backend returned no readable stream body')
  }

  let pendingRead = streamOpen.firstRead
  const decoder = new TextDecoder()
  let buffer = ''

  // Start a fresh visible generation for this request so Chat.tsx resets any
  // previous transient stream row/tool state before new deltas arrive.
  // This matters when the same streamId is reused across successive OpenAI
  // generations inside tool/repeat loops.
  const assistantMessageId = uuidv4()
  if (signal?.aborted) {
    await reader.cancel().catch(() => {})
    return
  }
  const isAbortRequested = () => Boolean(signal?.aborted)
  const emitChunk = (chunk: any) => {
    if (isAbortRequested()) return
    onChunk(chunk)
  }

  emitChunk({ type: 'generation_started', messageId: assistantMessageId })


  // Accumulators for final message
  let assistantText = ''
  let assistantReasoning = ''
  let completionEmitted = false
  const useGPT53StrictTextAssembly = shouldUseGPT53StrictTextAssembly(payload.modelName)

  // Tool call accumulator for incremental streaming
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>()
  const responseToolCallAccumulators = new Map<string, ToolCallAccumulator & { outputIndex?: number; seq: number }>()
  let responseToolCallSeq = 0
  let completedResponseOutputItems: any[] | null = null
  let responseTextSeq = 0
  const responseTextByItem = new Map<string, { text: string; outputIndex?: number; seq: number; fromDone: boolean }>()
  const emittedTextByItem = new Map<string, string>()
  const loggedGPT53SanitizationItems = new Set<string>()
  const responseOutputItems = new Map<
    string,
    {
      id: string
      type?: string
      role?: string
      phase?: string
      status?: string
      outputIndex?: number
      seq: number
    }
  >()

  const mergeOutputItem = (item?: ChatGPTResponseOutputItem) => {
    if (!item?.id) return

    const itemId = item.id
    const existing = responseOutputItems.get(itemId)
    const outputIndex =
      typeof item.output_index === 'number'
        ? item.output_index
        : typeof item.outputIndex === 'number'
          ? item.outputIndex
          : existing?.outputIndex

    responseOutputItems.set(itemId, {
      id: itemId,
      type: item.type ?? existing?.type,
      role: item.role ?? existing?.role,
      phase: item.phase ?? existing?.phase,
      status: item.status ?? existing?.status,
      outputIndex,
      seq: existing?.seq ?? responseTextSeq++,
    })
  }

  const upsertResponseText = (itemId: string, text: string, outputIndex?: number, fromDone: boolean = false) => {
    const existing = responseTextByItem.get(itemId)
    const nextOutputIndex = typeof outputIndex === 'number' ? outputIndex : existing?.outputIndex
    responseTextByItem.set(itemId, {
      text: fromDone ? text : (existing?.text || '') + text,
      outputIndex: nextOutputIndex,
      seq: existing?.seq ?? responseTextSeq++,
      fromDone: fromDone || Boolean(existing?.fromDone),
    })
  }

  const shouldEmitTextForEvent = (evt: any): boolean => {
    if (!useGPT53StrictTextAssembly) return true
    const itemId = extractItemId(evt)
    if (!itemId) return false
    const meta = responseOutputItems.get(itemId)
    if (!meta) return false
    if (meta.type && meta.type !== 'message') return false
    if (meta.role && meta.role !== 'assistant') return false
    if (meta.phase && meta.phase !== 'final_answer') return false
    return true
  }

  const emitTextDelta = (delta: string, itemId?: string) => {
    if (!delta) return
    assistantText += delta
    emitChunk({ type: 'chunk', part: 'text', delta })
    if (itemId) {
      emittedTextByItem.set(itemId, (emittedTextByItem.get(itemId) || '') + delta)
    }
  }

  const selectFinalAssistantText = (): string => {
    const logGPT53Sanitization = (itemId: string, rawText: string, sanitizedText: string) => {
      if (!useGPT53StrictTextAssembly) return
      if (itemId && loggedGPT53SanitizationItems.has(itemId)) return
      if (itemId) {
        loggedGPT53SanitizationItems.add(itemId)
      }
      console.warn('[OpenAI ChatGPT][gpt-5.3-codex] Sanitized leaked internal streamed text', {
        itemId,
        rawLength: rawText.length,
        sanitizedLength: sanitizedText.length,
        droppedChars: Math.max(rawText.length - sanitizedText.length, 0),
      })
    }

    const candidates: Array<{ text: string; score: number; seq: number }> = []

    for (const [itemId, textEntry] of responseTextByItem) {
      const rawText = textEntry.text || ''
      if (!rawText.trim()) continue

      const meta = responseOutputItems.get(itemId)
      let score = 0

      if (!meta?.type || meta.type === 'message') score += 4
      if (!meta?.role || meta.role === 'assistant') score += 3
      if (meta?.phase === 'final_answer') score += 8
      if (meta?.phase && meta.phase !== 'final_answer') score -= 3
      if (textEntry.fromDone) score += 2

      const sanitizedText = useGPT53StrictTextAssembly ? sanitizeGPT53Text(rawText) : rawText
      if (useGPT53StrictTextAssembly && sanitizedText !== rawText) {
        logGPT53Sanitization(itemId, rawText, sanitizedText)
      }
      if (!sanitizedText.trim()) continue

      candidates.push({
        text: sanitizedText,
        score,
        seq: textEntry.seq,
      })
    }

    if (candidates.length === 0) {
      if (!useGPT53StrictTextAssembly) return assistantText
      const sanitizedFallback = sanitizeGPT53Text(assistantText)
      if (sanitizedFallback !== assistantText) {
        logGPT53Sanitization('fallback', assistantText, sanitizedFallback)
      }
      return sanitizedFallback
    }

    candidates.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return b.seq - a.seq
    })

    return candidates[0].text
  }

  const addOrUpdateResponseToolCall = (itemId: string, item: ChatGPTResponseOutputItem): ToolCall | null => {
    const existing = responseToolCallAccumulators.get(itemId)
    const callId = item.call_id || item.id || itemId
    const name = item.name || existing?.name || ''
    const args = item.arguments ?? existing?.arguments ?? ''
    const outputIndex = typeof item.output_index === 'number' ? item.output_index : existing?.outputIndex

    if (existing) {
      existing.id = callId
      existing.name = name
      existing.arguments = args
      if (outputIndex != null) {
        existing.outputIndex = outputIndex
      }
    } else {
      responseToolCallAccumulators.set(itemId, {
        id: callId,
        name,
        arguments: args,
        outputIndex,
        seq: responseToolCallSeq++,
      })
    }

    if (!callId || !name) return null

    return {
      id: callId,
      name,
      arguments: parseToolArguments(args),
      status: 'pending',
    }
  }

  const getResponseOutputItemsForReplay = (): any[] => {
    if (Array.isArray(completedResponseOutputItems) && completedResponseOutputItems.length > 0) {
      return normalizeResponseOutputItemsForReplay(completedResponseOutputItems)
    }

    const fallbackMessages = Array.from(responseOutputItems.values())
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

    const fallbackFunctionCalls = Array.from(responseToolCallAccumulators.values())
      .sort((a, b) => {
        if (typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number') return a.outputIndex - b.outputIndex
        if (typeof a.outputIndex === 'number') return -1
        if (typeof b.outputIndex === 'number') return 1
        return a.seq - b.seq
      })
      .map(acc => ({
        type: 'function_call',
        call_id: acc.id,
        name: acc.name,
        arguments: acc.arguments || '',
        output_index: acc.outputIndex,
      }))
      .filter(item => item.call_id && item.name)

    return normalizeResponseOutputItemsForReplay([...fallbackMessages, ...fallbackFunctionCalls])
  }

  const parseToolArguments = (rawArgs: any): any => {
    if (typeof rawArgs !== 'string') return rawArgs
    try {
      return rawArgs ? JSON.parse(rawArgs) : rawArgs
    } catch {
      return rawArgs
    }
  }

  const emitToolCallChunk = (toolCall: ToolCall | null) => {
    if (!toolCall?.id || !toolCall?.name) return
    emitChunk({ type: 'chunk', part: 'tool_call', toolCall })
  }

  const extractAssistantMessageTextFromReplayItem = (item: any): string => {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) return ''
    return item.content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('')
  }

  const extractReasoningTextFromReplayItem = (item: any): string => {
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

  const buildLegacyFinalToolCalls = (): { toolCalls: ToolCall[]; contentBlocks: ContentBlock[] } => {
    const finalToolCalls: ToolCall[] = []
    const finalContentBlocks: ContentBlock[] = []
    const seen = new Set<string>()

    const responseEntries = Array.from(responseToolCallAccumulators.values()).sort((a, b) => {
      if (typeof a.outputIndex === 'number' && typeof b.outputIndex === 'number') {
        return a.outputIndex - b.outputIndex
      }
      if (typeof a.outputIndex === 'number') return -1
      if (typeof b.outputIndex === 'number') return 1
      return a.seq - b.seq
    })

    for (const acc of responseEntries) {
      const parsedArgs = parseToolArguments(acc.arguments)

      if (acc.id && !seen.has(acc.id)) {
        seen.add(acc.id)
        finalToolCalls.push({
          id: acc.id,
          name: acc.name,
          arguments: parsedArgs,
          status: 'pending',
        })
        finalContentBlocks.push({
          type: 'tool_use',
          index: finalContentBlocks.length,
          id: acc.id,
          name: acc.name,
          input: parsedArgs,
        })
      }
    }

    toolCallAccumulators.forEach((acc, index) => {
      const parsedArgs = parseToolArguments(acc.arguments)

      if (acc.id && !seen.has(acc.id)) {
        seen.add(acc.id)
        finalToolCalls.push({
          id: acc.id,
          name: acc.name,
          arguments: parsedArgs,
          status: 'pending',
        })
        finalContentBlocks.push({
          type: 'tool_use',
          index: index,
          id: acc.id,
          name: acc.name,
          input: parsedArgs,
        })
      }
    })

    return { toolCalls: finalToolCalls, contentBlocks: finalContentBlocks }
  }

  const buildFinalArtifactsFromReplayItems = (replayItems: any[]) => {
    const toolCalls: ToolCall[] = []
    const contentBlocks: ContentBlock[] = []
    const seenToolIds = new Set<string>()
    const reasoningSegments: string[] = []
    let nextIndex = 0

    for (const item of replayItems) {
      if (!item || typeof item !== 'object') continue

      if (item.type === 'message' && item.role === 'assistant') {
        if (useGPT53StrictTextAssembly && item.phase && item.phase !== 'final_answer') {
          continue
        }

        const rawText = extractAssistantMessageTextFromReplayItem(item)
        const text = useGPT53StrictTextAssembly ? sanitizeGPT53Text(rawText) : rawText
        if (!text.trim()) continue
        contentBlocks.push({
          type: 'text',
          index: nextIndex++,
          content: text,
        })
        continue
      }

      if (item.type === 'reasoning') {
        const reasoningText = extractReasoningTextFromReplayItem(item)
        if (!reasoningText) continue
        reasoningSegments.push(reasoningText)
        contentBlocks.push({
          type: 'thinking',
          index: nextIndex++,
          content: reasoningText,
        })
        continue
      }

      if (item.type === 'function_call') {
        const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : ''
        const name = typeof item.name === 'string' ? item.name : ''
        if (!callId || !name || seenToolIds.has(callId)) continue

        const parsedArgs = parseToolArguments(item.arguments)
        seenToolIds.add(callId)
        toolCalls.push({
          id: callId,
          name,
          arguments: parsedArgs,
          status: 'pending',
        })
        contentBlocks.push({
          type: 'tool_use',
          index: nextIndex++,
          id: callId,
          name,
          input: parsedArgs,
        })
      }
    }

    const assistantMessages = replayItems
      .filter(
        item =>
          item?.type === 'message' &&
          item?.role === 'assistant' &&
          (!useGPT53StrictTextAssembly || !item?.phase || item.phase === 'final_answer')
      )
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

    return {
      finalAssistantText: finalAnswerEntry?.text || fallbackEntry?.text || lastEntry?.text || '',
      finalReasoningText: reasoningSegments.join('\n\n').trim(),
      toolCalls,
      contentBlocks,
    }
  }

  const emitCompleteMessage = (partial: boolean): boolean => {
    if (completionEmitted || isAbortRequested()) return false

    const replayItems = getResponseOutputItemsForReplay()
    const replayArtifacts = buildFinalArtifactsFromReplayItems(replayItems)
    const legacyArtifacts = buildLegacyFinalToolCalls()
    const finalToolCalls = replayArtifacts.toolCalls.length > 0 ? [...replayArtifacts.toolCalls] : [...legacyArtifacts.toolCalls]
    const finalContentBlocks =
      replayArtifacts.contentBlocks.length > 0 ? [...replayArtifacts.contentBlocks] : [...legacyArtifacts.contentBlocks]
    const seenToolIds = new Set(finalToolCalls.map(toolCall => toolCall.id))

    if (replayArtifacts.contentBlocks.length > 0 && legacyArtifacts.toolCalls.length > 0) {
      for (const legacyToolCall of legacyArtifacts.toolCalls) {
        if (!legacyToolCall.id || seenToolIds.has(legacyToolCall.id)) continue
        seenToolIds.add(legacyToolCall.id)
        finalToolCalls.push(legacyToolCall)
        finalContentBlocks.push({
          type: 'tool_use',
          index: finalContentBlocks.length,
          id: legacyToolCall.id,
          name: legacyToolCall.name,
          input: legacyToolCall.arguments,
        })
      }
    }

    const finalAssistantText = replayArtifacts.finalAssistantText || selectFinalAssistantText()
    const finalReasoningText = replayArtifacts.finalReasoningText || assistantReasoning

    const hasThinkingBlock = finalContentBlocks.some(block => block?.type === 'thinking')

    if (finalReasoningText && !hasThinkingBlock) {
      // Important: ChatMessage prefers content_blocks over legacy thinking_block.
      // If reasoning was only emitted in stream deltas (assistantReasoning) and not in
      // replayItems, we must still persist a concrete `thinking` content_block or
      // reasoning disappears after reload even though it was visible during streaming.
      finalContentBlocks.unshift({
        type: 'thinking',
        index: 0,
        content: finalReasoningText,
      })

      console.debug('[OpenAI ChatGPT] Backfilled missing thinking block from streamed reasoning', {
        messageId: assistantMessageId,
        reasoningLength: finalReasoningText.length,
        replayItemsCount: replayItems.length,
      })
    }

    if (replayArtifacts.contentBlocks.length === 0 && finalAssistantText) {
      finalContentBlocks.unshift({
        type: 'text',
        index: 0,
        content: finalAssistantText,
      })
    }

    if (replayItems.length > 0) {
      finalContentBlocks.push({
        type: 'responses_output_items',
        index: finalContentBlocks.length,
        items: replayItems,
      } as any)
    }

    const hasMeaningfulContent =
      finalAssistantText.trim().length > 0 || finalReasoningText.trim().length > 0 || finalToolCalls.length > 0

    if (!hasMeaningfulContent) {
      return false
    }

    const message = buildAssistantMessage({
      id: assistantMessageId,
      conversationId: payload.conversationId,
      parentId: payload.parentId,
      modelName: payload.modelName,
      text: finalAssistantText,
      toolCalls: finalToolCalls,
      contentBlocks: finalContentBlocks,
      partial,
    })

    if (finalReasoningText) {
      message.thinking_block = finalReasoningText
    }

    if (replayItems.length > 0) {
      ;(message as any).responses_output_items = replayItems
    }

    if (finalToolCalls.length > 0) {
      console.log(
        '[OpenAI ChatGPT] Parsed tool calls from responses API:',
        finalToolCalls.map(tc => tc.name)
      )
    }

    completionEmitted = true
    emitChunk({ type: 'complete', message })
    return true
  }

  // Track reasoning fragments by stream key to avoid duplicate appends when both
  // delta and done events are emitted for the same reasoning segment.
  const reasoningByKey = new Map<string, string>()

  const emitReasoning = (delta: string) => {
    if (!delta) return
    assistantReasoning += delta
    emitChunk({ type: 'chunk', part: 'reasoning', delta })
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

    // Typical path: .done carries the complete text; append only the missing tail.
    if (fullText.startsWith(prev)) {
      emitReasoning(fullText.slice(prev.length))
      return
    }

    // If deltas were already streamed but the .done text differs (formatting or normalization),
    // don't append a second full copy. This avoids duplicate reasoning blocks/content.
    if (prev) {
      return
    }

    // If we never saw deltas for this key, append whole text once.
    if (!prev) {
      emitReasoning(fullText)
      return
    }
  }

  const extractItemId = (evt: any): string => {
    const raw = evt?.item_id ?? evt?.itemId ?? evt?.id ?? ''
    return typeof raw === 'string' ? raw : ''
  }

  const extractIndex = (evt: any, snakeKey: string, camelKey: string): number => {
    const raw = evt?.[snakeKey] ?? evt?.[camelKey]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  }

  const extractReasoningFromOutputItem = (item?: ChatGPTResponseOutputItem) => {
    if (!item || item.type !== 'reasoning') return

    const itemId = typeof item.id === 'string' ? item.id : 'unknown-reasoning-item'

    if (Array.isArray(item.content)) {
      item.content.forEach((part, contentIndex) => {
        if (part?.type === 'reasoning_text' && typeof part.text === 'string' && part.text) {
          applyReasoningDone(`reasoning_text:${itemId}:${contentIndex}`, part.text)
        }
      })
    }

    if (Array.isArray(item.summary)) {
      item.summary.forEach((part, summaryIndex) => {
        if (typeof part?.text === 'string' && part.text) {
          applyReasoningDone(`reasoning_summary:${itemId}:${summaryIndex}`, part.text)
        }
      })
    }
  }

  try {
    while (true) {
      if (isAbortRequested()) break
      const { done, value } = pendingRead ?? (await reader.read())
      pendingRead = null
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (isAbortRequested()) break
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const dataStr = trimmed.slice(5).trim()
        if (dataStr === '[DONE]') {
          continue
        }

        let parsed: ChatGPTStreamChunk | null = null
        try {
          parsed = JSON.parse(dataStr)
        } catch (e) {
          continue
        }

        if (!parsed) continue

        // Handle response.output_item events (ChatGPT format)
        if (parsed.type === 'response.output_item.added') {
          const item = (parsed as any).item as ChatGPTResponseOutputItem | undefined
          mergeOutputItem(item)
          if (item?.type === 'function_call' && item.id) {
            emitToolCallChunk(addOrUpdateResponseToolCall(item.id, item))
          }
          continue
        }

        if (parsed.type === 'response.output_text.delta') {
          const evt = parsed as any
          const delta = typeof evt.delta === 'string' ? evt.delta : ''
          if (delta) {
            const itemId = extractItemId(evt)
            const outputIndex = extractIndex(evt, 'output_index', 'outputIndex')
            if (itemId) {
              upsertResponseText(itemId, delta, outputIndex, false)
            }

            if (shouldEmitTextForEvent(evt)) {
              emitTextDelta(delta, itemId || undefined)
            }
          }
          continue
        }

        if (parsed.type === 'response.output_text.done') {
          const evt = parsed as any
          const fullText = typeof evt.text === 'string' ? evt.text : ''
          if (!fullText) continue

          const itemId = extractItemId(evt)
          const outputIndex = extractIndex(evt, 'output_index', 'outputIndex')
          if (itemId) {
            upsertResponseText(itemId, fullText, outputIndex, true)
          }
          continue
        }

        if (parsed.type === 'response.reasoning_text.delta' || parsed.type === 'response.reasoning_summary_text.delta') {
          const evt = parsed as any
          const delta = typeof evt.delta === 'string' ? evt.delta : ''
          if (!delta) continue

          const itemId = extractItemId(evt) || 'reasoning'
          if (parsed.type === 'response.reasoning_summary_text.delta') {
            const summaryIndex = extractIndex(evt, 'summary_index', 'summaryIndex')
            applyReasoningDelta(`reasoning_summary:${itemId}:${summaryIndex}`, delta)
          } else {
            const contentIndex = extractIndex(evt, 'content_index', 'contentIndex')
            applyReasoningDelta(`reasoning_text:${itemId}:${contentIndex}`, delta)
          }
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
          const itemId = (parsed as any).item_id as string | undefined
          const delta = (parsed as any).delta as string | undefined
          if (itemId) {
            const existing = responseToolCallAccumulators.get(itemId)
            if (existing) {
              existing.arguments += delta || ''
              emitToolCallChunk({
                id: existing.id,
                name: existing.name,
                arguments: parseToolArguments(existing.arguments),
                status: 'pending',
              })
            } else {
              responseToolCallAccumulators.set(itemId, {
                id: itemId,
                name: '',
                arguments: delta || '',
                seq: responseToolCallSeq++,
              })
            }
          }
          continue
        }

        if (parsed.type === 'response.function_call_arguments.done') {
          const itemId = (parsed as any).item_id as string | undefined
          const args = (parsed as any).arguments as string | undefined
          if (itemId) {
            const existing = responseToolCallAccumulators.get(itemId)
            if (existing) {
              existing.arguments = args || existing.arguments
              emitToolCallChunk({
                id: existing.id,
                name: existing.name,
                arguments: parseToolArguments(existing.arguments),
                status: 'pending',
              })
            } else {
              responseToolCallAccumulators.set(itemId, {
                id: itemId,
                name: '',
                arguments: args || '',
                seq: responseToolCallSeq++,
              })
            }
          }
          continue
        }

        if (parsed.type === 'response.output_item.done') {
          const item = (parsed as any).item as ChatGPTResponseOutputItem | undefined
          mergeOutputItem(item)
          if (item?.type === 'function_call' && item.id) {
            emitToolCallChunk(addOrUpdateResponseToolCall(item.id, item))
          }
          extractReasoningFromOutputItem(item)
          continue
        }

        if (parsed.type === 'response.failed' || parsed.type === 'response.incomplete') {
          const responseError = (parsed as any)?.response?.error
          const message =
            typeof responseError?.message === 'string' && responseError.message.trim().length > 0
              ? responseError.message
              : parsed.type === 'response.incomplete'
                ? 'OpenAI response was incomplete.'
                : 'OpenAI response failed.'
          throw new Error(message)
        }

        if (parsed.type === 'response.done') {
          continue
        }

        if (parsed.type === 'response.completed') {
          const responseOutput = (parsed as any)?.response?.output
          if (Array.isArray(responseOutput)) {
            completedResponseOutputItems = responseOutput
          }

          emitCompleteMessage(false)
          continue
        }

        // Handle OpenAI-style streaming (choices array)
        if (!parsed?.choices || parsed.choices.length === 0) continue

        const choice = parsed.choices[0]
        const delta = choice.delta || choice

        // Tool calls delta
        if (delta?.tool_calls) {
          const { newToolCalls, updatedIndices } = processToolCallDeltas(delta.tool_calls, toolCallAccumulators)
          newToolCalls.forEach(toolCall => emitToolCallChunk(toolCall))
          updatedIndices.forEach(index => {
            const acc = toolCallAccumulators.get(index)
            if (!acc?.id || !acc?.name) return
            emitToolCallChunk({
              id: acc.id,
              name: acc.name,
              arguments: parseToolArguments(acc.arguments),
              status: 'pending',
            })
          })
        }

        // Text delta (OpenAI-style)
        if (delta?.content) {
          const textDelta = typeof delta.content === 'string' ? delta.content : ''
          if (textDelta) {
            emitTextDelta(textDelta)
          }
        }

        // Reasoning delta
        if (delta?.reasoning) {
          const reasoningDelta = typeof delta.reasoning === 'string' ? delta.reasoning : ''
          if (reasoningDelta) {
            assistantReasoning += reasoningDelta
            emitChunk({ type: 'chunk', part: 'reasoning', delta: reasoningDelta })
          }
        }

        // finish_reason - build final message
        if (choice.finish_reason) {
          emitCompleteMessage(false)
        }
      }
    }

    if (!completionEmitted && !isAbortRequested()) {
      emitCompleteMessage(false)
    }
  } catch (error) {
    const isAbortError = (error instanceof Error && error.name === 'AbortError') || signal?.aborted
    if (isAbortError) {
      return
    }
    throw error
  } finally {
    reader.releaseLock()
  }
}
