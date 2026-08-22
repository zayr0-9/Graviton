import { randomUUID } from 'crypto'
import type { ProviderGenerateInput, ProviderToolCall } from './openRouterProvider.js'

export type ContentBlock = {
  type?: string
  content?: any
  id?: string
  name?: string
  input?: any
  tool_use_id?: string
  index?: number
}

export type HyperMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoningContent?: string
  name?: string
  date: Date
  toolCallId?: string
  toolCalls?: Array<{ id?: string; toolName: string; args: unknown }>
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

export function reasoningFromBlocks(blocks: ContentBlock[]): string | undefined {
  const reasoning = blocks
    .filter(block => block?.type === 'thinking' && typeof block.content === 'string')
    .map(block => block.content)
    .join('')
  return reasoning || undefined
}

export function toolCallsFromBlocks(blocks: ContentBlock[]): Array<{ id?: string; toolName: string; args: unknown }> {
  return blocks
    .filter(block => block?.type === 'tool_use' && typeof block.name === 'string')
    .map(block => ({
      ...(typeof block.id === 'string' && block.id ? { id: block.id } : {}),
      toolName: String(block.name),
      args: block.input ?? {},
    }))
}

export function toolResultMessagesFromBlocks(blocks: ContentBlock[], createdAt: Date): HyperMessage[] {
  return blocks
    .filter(block => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map(block => ({
      role: 'tool' as const,
      content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? null),
      toolCallId: String(block.tool_use_id),
      date: createdAt,
    }))
}

export function messageDate(message: any): Date {
  const raw = message?.created_at ?? message?.createdAt ?? message?.date
  const parsed = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : new Date()
}

export function toHyperMessages(input: ProviderGenerateInput): HyperMessage[] {
  const messages: HyperMessage[] = []

  if (input.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: input.systemPrompt.trim(), date: new Date() })
  }

  for (const msg of input.history || []) {
    if (!msg || msg.role === 'ex_agent') continue
    const date = messageDate(msg)
    const blocks = parseContentBlocks(msg.content_blocks)
    const blockText = textFromBlocks(blocks)

    if (msg.role === 'assistant') {
      const toolCalls = toolCallsFromBlocks(blocks)
      const reasoning = reasoningFromBlocks(blocks)
      messages.push({
        role: 'assistant',
        content: blockText || (typeof msg.content === 'string' ? msg.content : ''),
        date,
        ...(reasoning ? { reasoningContent: reasoning } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      })
      messages.push(...toolResultMessagesFromBlocks(blocks, date))
      continue
    }

    if (msg.role === 'user' || msg.role === 'system') {
      const content = blockText || (typeof msg.content === 'string' ? msg.content : '')
      if (content.trim()) {
        messages.push({ role: msg.role, content, date })
      }
    }
  }

  if (input.userContent?.trim()) {
    messages.push({ role: 'user', content: input.userContent, date: new Date() })
  }

  return messages
}

export function toHyperTools(input: ProviderGenerateInput): any[] {
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

export function toProviderToolCalls(toolCalls: Array<{ id?: string; toolName: string; args: unknown }> | undefined): ProviderToolCall[] {
  return (toolCalls || [])
    .filter(call => call?.toolName)
    .map(call => ({
      id: call.id || randomUUID(),
      name: call.toolName,
      arguments: call.args ?? {},
      status: 'pending' as const,
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

export function normalizeBearer(token: string | null | undefined): string {
  return String(token || '').replace(/^Bearer\s+/i, '').trim()
}
