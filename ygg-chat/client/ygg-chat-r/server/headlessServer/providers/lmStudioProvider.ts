import type {
  HeadlessProvider,
  ProviderGenerateInput,
  ProviderGenerateOutput,
  ProviderStreamEventHandler,
  ProviderToolCall,
} from './openRouterProvider.js'
import { buildToolNameMap, sanitizeToolResultContentForModel } from './toolResultSanitizer.js'

interface LmStudioMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

function parseJson(value: any, fallback: any): any {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return value
}

function parseContentBlocks(value: any): any[] {
  const parsed = parseJson(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function parseToolCalls(value: any): any[] {
  const parsed = parseJson(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function asText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (item?.type === 'text' && typeof item?.text === 'string') return item.text
        if (typeof item?.content === 'string') return item.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (value == null) return ''
  return String(value)
}

function toToolSchema(tools: ProviderGenerateInput['tools']): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined

  const mapped = tools
    .filter(tool => tool?.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema || { type: 'object', properties: {} },
      },
    }))

  return mapped.length ? mapped : undefined
}

function appendToolOutputsFromBlocks(
  messages: LmStudioMessage[],
  assistantMsg: any,
  fallbackToolNameById: Map<string, string>
): void {
  const blocks = parseContentBlocks(assistantMsg?.content_blocks)
  for (const block of blocks) {
    if (block?.type !== 'tool_result') continue
    const callId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : ''
    if (!callId) continue

    const toolName = fallbackToolNameById.get(callId) || null
    const sanitized = sanitizeToolResultContentForModel(block?.content, toolName)
    const output = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized ?? null)
    messages.push({ role: 'tool', tool_call_id: callId, content: output })
  }
}

function transformHistoryToMessages(history: any[], userContent: string, systemPrompt?: string | null): LmStudioMessage[] {
  const messages: LmStudioMessage[] = []
  const toolNameById = buildToolNameMap(history)

  if (systemPrompt && systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() })
  }

  for (const msg of history || []) {
    if (!msg) continue

    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      const content = asText(msg.content).trim()
      if (content) {
        messages.push({ role: 'user', content })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const content = asText(msg.content)
      const toolCalls = parseToolCalls(msg.tool_calls)
        .map((call: any) => {
          const id = typeof call?.id === 'string' ? call.id : ''
          const name = typeof call?.name === 'string' ? call.name : typeof call?.function?.name === 'string' ? call.function.name : ''
          const argsRaw = call?.arguments ?? call?.function?.arguments ?? '{}'
          const args = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw || {})
          if (!id || !name) return null
          return {
            id,
            type: 'function' as const,
            function: { name, arguments: args },
          }
        })
        .filter((call): call is NonNullable<typeof call> => Boolean(call))

      messages.push({
        role: 'assistant',
        content: content || '',
        tool_calls: toolCalls.length ? toolCalls : undefined,
      })

      appendToolOutputsFromBlocks(messages, msg, toolNameById)
      continue
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      const callId = String(msg.tool_call_id)
      const sanitized = sanitizeToolResultContentForModel(msg.content, toolNameById.get(callId) || null)
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized ?? null),
      })
    }
  }

  const trimmedUserContent = userContent.trim()
  const hasAnyUser = messages.some(message => message.role === 'user')
  if (trimmedUserContent && !hasAnyUser) {
    messages.push({ role: 'user', content: trimmedUserContent })
  }

  return messages
}

function parseResponseToolCalls(message: any): ProviderToolCall[] {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  return calls
    .map((call: any) => {
      const id = typeof call?.id === 'string' ? call.id : ''
      const name = typeof call?.function?.name === 'string' ? call.function.name : ''
      const argsRaw = call?.function?.arguments
      if (!id || !name) return null

      let args: any = argsRaw ?? {}
      if (typeof argsRaw === 'string') {
        try {
          args = JSON.parse(argsRaw)
        } catch {
          args = argsRaw
        }
      }

      return {
        id,
        name,
        arguments: args,
        status: 'pending' as const,
      }
    })
    .filter((call: ProviderToolCall | null): call is ProviderToolCall => Boolean(call))
}

export class LmStudioProvider implements HeadlessProvider {
  readonly name = 'lmstudio'

  async generate(input: ProviderGenerateInput, _emit?: ProviderStreamEventHandler): Promise<ProviderGenerateOutput> {
    const baseUrl = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1'
    const model = input.modelName || process.env.LMSTUDIO_MODEL || 'local-model'
    const messages = transformHistoryToMessages(input.history || [], input.userContent, input.systemPrompt)
    const tools = toToolSchema(input.tools)

    const body: Record<string, any> = {
      model,
      messages,
      stream: false,
      temperature: 0.7,
    }

    if (tools?.length) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }

    if (input.accessToken) {
      headers.authorization = `Bearer ${input.accessToken}`
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LM Studio request failed (${response.status}): ${text}`)
    }

    const json = (await response.json()) as any
    const message = json?.choices?.[0]?.message || {}
    const content = asText(message?.content)
    const toolCalls = parseResponseToolCalls(message)

    const contentBlocks: any[] = []
    if (content) {
      contentBlocks.push({ type: 'text', content })
    }
    for (const toolCall of toolCalls) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments,
      })
    }

    return {
      content,
      toolCalls,
      contentBlocks,
      raw: json,
    }
  }
}
