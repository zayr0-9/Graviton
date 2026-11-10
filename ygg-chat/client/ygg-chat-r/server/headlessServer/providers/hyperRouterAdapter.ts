import { randomUUID } from 'crypto'
import type {
  AnyToolDefinition,
  AssistantBlock,
  JsonValue,
  Message,
  ModelProvider,
  ModelResponse,
  ToolResultBlock,
} from '@hyper-labs/hyper-router'
import type { ProviderGenerateInput, ProviderGenerateOutput, ProviderToolCall } from './providerTypes.js'

export type ContentBlock = {
  type?: string
  content?: any
  id?: string
  name?: string
  input?: any
  tool_use_id?: string
  is_error?: boolean
  index?: number
}

export function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback
  if (Array.isArray(value)) return value as T
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

export function parseContentBlocks(value: any): ContentBlock[] {
  const parsed = parseJson<ContentBlock[]>(value, [])
  return Array.isArray(parsed)
    ? [...parsed].sort((a, b) => (typeof a?.index === 'number' ? a.index : 0) - (typeof b?.index === 'number' ? b.index : 0))
    : []
}

export function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block?.type === 'text' && typeof block.content === 'string')
    .map(block => block.content)
    .join('')
}

export function messageDate(message: any): Date {
  const raw = message?.created_at ?? message?.createdAt ?? message?.date
  const parsed = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date()
}

/** Canonical blocks reject `undefined`, functions and other non-JSON values. */
function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return {}
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return {}
  }
}

function toolResultText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? null)
}

/** Tool call ids are required by every canonical codec; legacy rows may lack one. */
function toolUseIds(blocks: ContentBlock[], messageIndex: number): Map<ContentBlock, string> {
  const ids = new Map<ContentBlock, string>()
  blocks.forEach((block, blockIndex) => {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string') return
    ids.set(block, typeof block.id === 'string' && block.id ? block.id : `call_${messageIndex}_${blockIndex}`)
  })
  return ids
}

function assistantBlocks(blocks: ContentBlock[], ids: Map<ContentBlock, string>, fallbackText: string): AssistantBlock[] {
  const content: AssistantBlock[] = []
  for (const block of blocks) {
    if (block?.type === 'thinking' && typeof block.content === 'string' && block.content) {
      content.push({ type: 'reasoning', text: block.content })
    } else if (block?.type === 'text' && typeof block.content === 'string' && block.content) {
      content.push({ type: 'text', text: block.content })
    } else if (ids.has(block)) {
      content.push({
        type: 'tool_call',
        execution: 'local',
        call: { id: ids.get(block)!, toolName: String(block.name), args: toJsonValue(block.input ?? {}) },
      })
    }
  }
  if (!content.some(block => block.type === 'text') && fallbackText) content.unshift({ type: 'text', text: fallbackText })
  return content
}

/**
 * Tool results live in the assistant row's `content_blocks` (see toolLoopService's
 * markToolFailureForModel); `role:'tool'` history rows are ignored. Failures are
 * already spelled out in the text, so the text is the model-visible presentation.
 */
function toolResultBlocks(blocks: ContentBlock[], toolNames: Map<string, string>): ToolResultBlock[] {
  return blocks
    .filter(block => block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id)
    .map(block => {
      const text = toolResultText(block.content)
      return {
        type: 'tool_result' as const,
        toolCallId: String(block.tool_use_id),
        toolName: toolNames.get(String(block.tool_use_id)) ?? 'unknown_tool',
        execution: 'local' as const,
        result: block.is_error
          ? { ok: false, error: text, content: [{ type: 'text' as const, text }] }
          : { ok: true, output: text, content: [{ type: 'text' as const, text }] },
      }
    })
}

export function toHyperMessages(input: ProviderGenerateInput, options: { replayReasoning?: boolean } = {}): Message[] {
  if (input.history?.some(message => message?.role === 'user' && message.artifacts?.length)) {
    throw new Error('Image attachments are not supported by this provider adapter. Use ChatGPT, OpenRouter, or a vision-capable LM Studio model.')
  }
  const messages: Message[] = []

  if (input.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: [{ type: 'text', text: input.systemPrompt.trim() }], date: new Date() })
  }

  const history = (input.history || []).filter(msg => msg && msg.role !== 'ex_agent')
  const parsed = history.map(msg => parseContentBlocks(msg.content_blocks))
  const callIds = parsed.map((blocks, index) => toolUseIds(blocks, index))
  const toolNames = new Map<string, string>()
  callIds.forEach(ids => ids.forEach((id, block) => toolNames.set(id, String(block.name))))

  history.forEach((msg, index) => {
    const date = messageDate(msg)
    const blocks = parsed[index]
    const fallbackText = typeof msg.content === 'string' ? msg.content : ''

    if (msg.role === 'assistant') {
      const replayed = options.replayReasoning === false ? blocks.filter(block => block?.type !== 'thinking') : blocks
      const content = assistantBlocks(replayed, callIds[index], fallbackText)
      if (content.length) messages.push({ role: 'assistant', content, date })
      const results = toolResultBlocks(blocks, toolNames)
      if (results.length) messages.push({ role: 'tool', content: results, date })
      return
    }

    if (msg.role === 'user' || msg.role === 'system') {
      const text = textFromBlocks(blocks) || fallbackText
      if (text.trim()) messages.push({ role: msg.role, content: [{ type: 'text', text }], date })
    }
  })

  if (input.userContent?.trim()) {
    messages.push({ role: 'user', content: [{ type: 'text', text: input.userContent }], date: new Date() })
  }

  return messages
}

export function toHyperTools(input: ProviderGenerateInput): AnyToolDefinition[] {
  return (input.tools || [])
    .filter(tool => tool?.name)
    .map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      async execute() {
        throw new Error('Tool execution is handled by Yggdrasil ToolLoopService')
      },
    }))
}

export function buildContentBlocks(content: string, reasoning: string | undefined, toolCalls: ProviderToolCall[]): any[] {
  const blocks: any[] = []
  if (reasoning) blocks.push({ type: 'thinking', content: reasoning })
  if (content) blocks.push({ type: 'text', content })
  for (const call of toolCalls) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
  }
  return blocks
}

/** Flatten canonical assistant messages into Graviton's provider output; hosted/opaque blocks are dropped. */
export function fromHyperResponse(response: ModelResponse): ProviderGenerateOutput {
  let content = ''
  let reasoning = ''
  const toolCalls: ProviderToolCall[] = []
  for (const message of response.messages) {
    for (const block of message.content) {
      if (block.type === 'text') content += block.text
      else if (block.type === 'reasoning') reasoning += block.text
      else if (block.type === 'tool_call' && block.execution === 'local') {
        toolCalls.push({
          id: block.call.id || randomUUID(),
          name: block.call.toolName,
          arguments: block.call.args ?? {},
          status: 'pending',
        })
      }
    }
  }
  return {
    content,
    reasoning: reasoning || undefined,
    toolCalls,
    contentBlocks: buildContentBlocks(content, reasoning || undefined, toolCalls),
    raw: response,
  }
}

/**
 * Graviton is the transcript owner and replays full history every turn, so each call
 * claims ownership for the target provider. Stored rows carry no provider-native
 * content, so the claim never conflicts with foreign replay data.
 */
export async function generateWithHyperProvider(
  provider: ModelProvider,
  model: string,
  input: ProviderGenerateInput,
  options: { tools?: AnyToolDefinition[]; replayReasoning?: boolean } = {}
): Promise<ProviderGenerateOutput> {
  const response = await provider.generate({
    model,
    messages: toHyperMessages(input, { replayReasoning: options.replayReasoning }),
    tools: options.tools ?? toHyperTools(input),
    historyOwnership: { kind: 'provider', identity: provider.historyIdentity(model) },
    previousSessionMetadata: null,
    signal: input.signal,
  })
  return fromHyperResponse(response)
}

export function normalizeBearer(token: string | null | undefined): string {
  return String(token || '').replace(/^Bearer\s+/i, '').trim()
}
