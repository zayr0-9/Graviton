import { v4 as uuidv4 } from 'uuid'
import type { ConversationId, MessageId, ToolDefinition as SharedToolDefinition } from '../../../../../shared/types'
import { localApi } from '../../utils/api'
import type { ContentBlock, Message, ToolCall } from './chatTypes'

export interface ZaiStreamHandlers {
  onChunk: (chunk: any) => void | Promise<void>
  signal?: AbortSignal
}

export interface ZaiRequestPayload {
  conversationId: ConversationId
  parentId: MessageId | null
  modelName: string
  systemPrompt: string
  messages: any[]
  userId?: string | null
  provider?: 'zai' | 'bedrock'
  think?: boolean
  temperature?: number
  tools?: SharedToolDefinition[]
}

const parseToolArgs = (value: any) => {
  if (value == null) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

const normalizeToolCall = (toolCall: any): ToolCall | null => {
  if (!toolCall || typeof toolCall !== 'object') return null
  const id = String(toolCall.id || toolCall.tool_use_id || uuidv4())
  const name = String(toolCall.name || toolCall.toolName || toolCall.function?.name || '').trim()
  if (!name) return null
  const args = toolCall.arguments ?? toolCall.args ?? toolCall.input ?? toolCall.function?.arguments ?? {}
  return { id, name, arguments: parseToolArgs(args), status: 'pending' }
}

const toProviderTools = (tools?: SharedToolDefinition[]) =>
  (tools || [])
    .filter(tool => tool.enabled !== false && tool.name)
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    }))

const asContentBlocks = (value: any, text: string, reasoning: string, toolCalls: ToolCall[]): ContentBlock[] => {
  const parsed = Array.isArray(value) ? value : []
  const blocks = parsed.length > 0 ? [...parsed] : []
  const hasThinking = blocks.some(block => block?.type === 'thinking')
  const hasText = blocks.some(block => block?.type === 'text')

  if (reasoning && !hasThinking) blocks.unshift({ type: 'thinking', content: reasoning, index: 0 } as any)
  if (text && !hasText) blocks.push({ type: 'text', content: text, index: blocks.length } as any)

  for (const toolCall of toolCalls) {
    if (!blocks.some(block => block?.type === 'tool_use' && block?.id === toolCall.id)) {
      blocks.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.arguments, index: blocks.length } as any)
    }
  }

  return blocks.map((block, index) => ({ ...block, index: typeof block?.index === 'number' ? block.index : index }))
}

const buildAssistantMessage = (params: {
  id: string
  conversationId: ConversationId
  parentId: MessageId | null
  modelName: string
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  contentBlocks: ContentBlock[]
}): Message => ({
  id: params.id,
  conversation_id: params.conversationId,
  parent_id: params.parentId,
  children_ids: [],
  role: 'assistant',
  content: params.text,
  content_plain_text: params.text,
  thinking_block: params.reasoning || '',
  tool_calls: params.toolCalls,
  model_name: params.modelName,
  partial: false,
  created_at: new Date().toISOString(),
  artifacts: [],
  pastedContext: [],
  content_blocks: params.contentBlocks,
})

export async function createZaiStreamingRequest(payload: ZaiRequestPayload, handlers: ZaiStreamHandlers) {
  const { onChunk, signal } = handlers
  const assistantMessageId = uuidv4()
  if (signal?.aborted) return

  await onChunk({ type: 'generation_started', messageId: assistantMessageId })

  const response = await localApi.post<any>('/headless/ephemeral/chat', {
    provider: payload.provider || 'zai',
    modelName: payload.modelName,
    content: '',
    history: payload.messages,
    systemPrompt: payload.systemPrompt,
    userId: payload.userId,
    tools: toProviderTools(payload.tools),
    think: payload.think,
    temperature: payload.temperature,
  })

  if (signal?.aborted) return
  if (response?.success === false) throw new Error(response.error || (payload.provider === 'bedrock' ? 'AWS Bedrock request failed' : 'Z.AI request failed'))

  const text = typeof response?.message?.content === 'string' ? response.message.content : typeof response?.content === 'string' ? response.content : ''
  const reasoning = typeof response?.reasoning === 'string' ? response.reasoning : ''
  const toolCalls = (Array.isArray(response?.toolCalls) ? response.toolCalls : []).map(normalizeToolCall).filter(Boolean) as ToolCall[]
  const contentBlocks = asContentBlocks(response?.contentBlocks, text, reasoning, toolCalls)

  if (reasoning) await onChunk({ type: 'chunk', part: 'reasoning', delta: reasoning, content: reasoning })
  if (text) await onChunk({ type: 'chunk', part: 'text', delta: text, content: text })
  for (const toolCall of toolCalls) {
    await onChunk({ type: 'chunk', part: 'tool_call', toolCall })
  }

  await onChunk({
    type: 'complete',
    message: buildAssistantMessage({
      id: assistantMessageId,
      conversationId: payload.conversationId,
      parentId: payload.parentId,
      modelName: payload.modelName,
      text,
      reasoning,
      toolCalls,
      contentBlocks,
    }),
  })
}
