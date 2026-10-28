import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateMessages } from '@hyper-labs/hyper-router'
import { OpenRouterProvider } from '@hyper-labs/hyper-router/providers/openrouter'
import { z } from 'zod'
import { generateWithHyperProvider, toHyperMessages } from '../hyperRouterAdapter.js'
import { HyperRouterZaiProvider } from '../hyperRouterZaiProvider.js'
import { HyperRouterOpenRouterProvider, toOpenRouterTools } from '../hyperRouterOpenRouterProvider.js'

const readFileTool = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
}

const input: any = {
  modelName: 'glm-5.1',
  systemPrompt: 'Be brief.',
  userContent: 'and now?',
  tools: [readFileTool],
  history: [
    { role: 'user', content: 'read a.txt' },
    {
      role: 'assistant',
      content: 'Reading.',
      content_blocks: JSON.stringify([
        { type: 'thinking', content: 'need the file', index: 0 },
        { type: 'text', content: 'Reading.', index: 1 },
        { type: 'tool_use', id: 'call_ok', name: 'read_file', input: { path: 'a.txt', skip: undefined }, index: 2 },
        { type: 'tool_use', name: 'read_file', input: { path: 'b.txt' }, index: 3 },
        { type: 'tool_result', tool_use_id: 'call_ok', content: 'hello', index: 4 },
        { type: 'tool_result', tool_use_id: 'call_1_3', content: { error: 'missing' }, is_error: true, index: 5 },
      ]),
    },
    { role: 'ex_agent', content: 'ignored' },
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('hyper-router canonical history', () => {
  it('projects Graviton rows into valid canonical messages with tool results after their calls', () => {
    const messages = toHyperMessages(input)
    validateMessages(messages)
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(messages[2].content).toEqual([
      { type: 'reasoning', text: 'need the file' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool_call', execution: 'local', call: { id: 'call_ok', toolName: 'read_file', args: { path: 'a.txt' } } },
      { type: 'tool_call', execution: 'local', call: { id: 'call_1_3', toolName: 'read_file', args: { path: 'b.txt' } } },
    ])
    expect(messages[3].content).toEqual([
      { type: 'tool_result', toolCallId: 'call_ok', toolName: 'read_file', execution: 'local',
        result: { ok: true, output: 'hello', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'tool_result', toolCallId: 'call_1_3', toolName: 'read_file', execution: 'local',
        result: { ok: false, error: '{"error":"missing"}', content: [{ type: 'text', text: '{"error":"missing"}' }] } },
    ])
  })

  it('drops stored reasoning when replay is disabled', () => {
    const assistant = toHyperMessages(input, { replayReasoning: false }).find(message => message.role === 'assistant')
    expect(assistant?.content.some(block => block.type === 'reasoning')).toBe(false)
  })
})

describe('HyperRouterZaiProvider', () => {
  it('replays assistant/tool history under provider ownership and maps the response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Done.', reasoning_content: 'thought',
        tool_calls: [{ id: 'call_next', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.txt"}' } }] } }],
    })))
    vi.stubGlobal('fetch', fetch)

    const output = await new HyperRouterZaiProvider().generate({ ...input, accessToken: 'zai-key' })

    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.messages.filter((message: any) => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'call_ok', content: 'hello' },
      { role: 'tool', tool_call_id: 'call_1_3', content: '{"error":"missing"}' },
    ])
    expect(output.content).toBe('Done.')
    expect(output.reasoning).toBe('thought')
    expect(output.toolCalls).toEqual([{ id: 'call_next', name: 'read_file', arguments: { path: 'c.txt' }, status: 'pending' }])
    expect(output.contentBlocks).toEqual([
      { type: 'thinking', content: 'thought' },
      { type: 'text', content: 'Done.' },
      { type: 'tool_use', id: 'call_next', name: 'read_file', input: { path: 'c.txt' } },
    ])
  })

  it('forwards cancellation to the SDK request', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn())
    await expect(new HyperRouterZaiProvider().generate({ ...input, accessToken: 'zai-key', signal: controller.signal })).rejects.toThrow()
  })
})

describe('OpenRouter BYOK provider', () => {
  it('converts JSON Schema tools to Zod without losing parameters', () => {
    const [tool] = toOpenRouterTools(input)
    expect(z.toJSONSchema(tool.inputSchema as z.ZodType)).toMatchObject({
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
    })
  })

  it('round-trips history and tool calls through the hyper-router OpenRouter adapter', async () => {
    const callModel = vi.fn().mockReturnValue({ getResponse: async () => ({
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'Next.', annotations: [] }] },
        { type: 'function_call', callId: 'call_next', name: 'read_file', arguments: '{"path":"c.txt"}', status: 'completed' },
      ],
    }) })
    const provider = new OpenRouterProvider({ client: { callModel } as any })

    const output = await generateWithHyperProvider(provider, 'openai/gpt-5-mini', input, {
      tools: toOpenRouterTools(input),
      replayReasoning: false,
    })

    const request = callModel.mock.calls[0][0]
    expect(request.model).toBe('openai/gpt-5-mini')
    expect(request.input.some((item: any) => item.type === 'reasoning')).toBe(false)
    expect(request.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.callId)).toEqual(['call_ok', 'call_1_3'])
    expect(output.content).toBe('Next.')
    expect(output.toolCalls).toEqual([{ id: 'call_next', name: 'read_file', arguments: { path: 'c.txt' }, status: 'pending' }])
  })

  it('fails fast without an API key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    await expect(new HyperRouterOpenRouterProvider().generate({ ...input, modelName: 'openai/gpt-5-mini' })).rejects.toThrow('OpenRouter API key missing')
    vi.unstubAllEnvs()
  })
})
