import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiChatgptProvider } from '../openaiChatgptProvider.js'

function createSseStream(events: any[]) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

describe('OpenAiChatgptProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.OPENAI_CHATGPT_ACCESS_TOKEN
    delete process.env.OPENAI_ACCESS_TOKEN
    delete process.env.OPENAI_CHATGPT_ACCOUNT_ID
    delete process.env.YGG_OPENAI_CHATGPT_DEBUG_LOGS
    delete process.env.YGG_CODEX_DEV_LOGS
  })

  it('enables parallel tool calls and preserves final_answer text for gpt-5.3-codex', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig'
    process.env.YGG_CODEX_DEV_LOGS = 'true'

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const headers = new Headers(init?.headers as any)
      expect(body.parallel_tool_calls).toBe(true)
      expect(body.prompt_cache_key).toEqual(expect.stringMatching(/^ygg-chat:/))
      expect(body.client_metadata).toEqual({ 'x-codex-installation-id': body.prompt_cache_key })
      expect(headers.get('ChatGPT-Account-ID')).toBe('acct-1')
      expect(headers.get('originator')).toBe('codex_cli_rs')
      expect(headers.get('x-client-request-id')).toBe(body.prompt_cache_key)
      expect(headers.get('session-id')).toBe(body.prompt_cache_key)
      expect(headers.get('thread-id')).toBe(body.prompt_cache_key)
      expect(headers.get('user-agent')).toBe('Qubit/0.1 Codex')
      expect(body.service_tier).toBeUndefined()
      expect(body.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources'])
      expect(body.tools).toEqual(expect.arrayContaining([{ type: 'web_search' }, { type: 'image_generation' }]))
      expect(body.tools.find((tool: any) => tool.name === 'read_file')).toEqual(
        expect.objectContaining({
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          strict: false,
          parameters: { type: 'object', properties: {} },
        })
      )

      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: createSseStream([
          {
            type: 'response.output_item.added',
            item: {
              id: 'msg-commentary',
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              output_index: 0,
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg-commentary',
            output_index: 0,
            delta: 'assistant to=functions.read_file {"path":"/tmp/localServer.ts"}',
          },
          {
            type: 'response.output_item.added',
            item: {
              id: 'msg-final',
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              output_index: 1,
            },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg-final',
            output_index: 1,
            delta: 'Final safe answer',
          },
          {
            type: 'response.output_item.done',
            item: {
              id: 'call-1',
              type: 'function_call',
              call_id: 'call-1',
              name: 'read_file',
              arguments: '{"path":"README.md"}',
              output_index: 2,
            },
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp-1',
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 40 },
                output_tokens: 25,
                output_tokens_details: { reasoning_tokens: 5 },
                total_tokens: 125,
              },
              output: [
                {
                  id: 'msg-commentary',
                  type: 'message',
                  role: 'assistant',
                  phase: 'commentary',
                  output_index: 0,
                  content: [{ type: 'output_text', text: 'assistant to=functions.read_file {"path":"/tmp/localServer.ts"}' }],
                },
                {
                  id: 'msg-final',
                  type: 'message',
                  role: 'assistant',
                  phase: 'final_answer',
                  output_index: 1,
                  content: [{ type: 'output_text', text: 'Final safe answer' }],
                },
                {
                  id: 'call-1',
                  type: 'function_call',
                  call_id: 'call-1',
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                  output_index: 2,
                },
              ],
            },
          },
        ]),
        text: async () => '',
      } as any
    })

    const provider = new OpenAiChatgptProvider()
    const events: any[] = []
    const result = await provider.generate(
      {
        modelName: 'gpt-5.3-codex',
        history: [],
        userContent: 'hello',
        tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }],
      },
      event => events.push(event)
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('Final safe answer')
    expect(result.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'read_file',
        arguments: { path: 'README.md' },
        status: 'pending',
      },
    ])
    expect(result.raw?.responses_output_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message', phase: 'final_answer', output_index: 1 }),
        expect.objectContaining({ type: 'function_call', call_id: 'call-1', output_index: 2 }),
      ])
    )
    expect(events).toContainEqual({ type: 'chunk', part: 'text', delta: 'Final safe answer' })
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'chunk',
        part: 'text',
        delta: expect.stringContaining('assistant to=functions.read_file'),
      })
    )
    expect(infoSpy).toHaveBeenCalledWith(
      '[Codex Usage]',
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        responseId: 'resp-1',
        requestMode: 'qubit_exact_full_replay',
        hasPreviousResponseId: false,
        inputTokens: 100,
        cachedInputTokens: 40,
        uncachedInputTokens: 60,
        cacheHitRate: '40.00%',
        outputTokens: 25,
        reasoningTokens: 5,
        totalTokens: 125,
      })
    )
    expect(infoSpy.mock.calls).not.toEqual(
      expect.arrayContaining([[expect.stringContaining('[OpenAI ChatGPT] stream event'), expect.anything()]])
    )
  })

  it('uses full replay instead of previous_response_id for Codex tool continuations', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0zIn19.sig'

    let capturedBody: any = null
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}'))
      const headers = new Headers(init?.headers as any)
      expect(headers.get('originator')).toBe('codex_cli_rs')
      expect(headers.get('session-id')).toBe('conversation-cache-key')
      expect(headers.get('thread-id')).toBe('conversation-cache-key')
      expect(headers.get('x-client-request-id')).toBe('run-cache-key')
      expect(headers.get('ChatGPT-Account-ID')).toBe('acct-3')
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: createSseStream([
          {
            type: 'response.completed',
            response: {
              id: 'resp-full-replay',
              usage: {
                input_tokens: 120,
                input_tokens_details: { cached_tokens: 90 },
                output_tokens: 10,
                total_tokens: 130,
              },
              output: [
                {
                  id: 'msg-final',
                  type: 'message',
                  role: 'assistant',
                  phase: 'final_answer',
                  output_index: 0,
                  content: [{ type: 'output_text', text: 'Final answer after replay' }],
                },
              ],
            },
          },
        ]),
        text: async () => '',
      } as any
    })

    const provider = new OpenAiChatgptProvider()
    const result = await provider.generate({
      modelName: 'gpt-5.5',
      userContent: '',
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }],
      railwayTurn: {
        conversationId: 'conversation-cache-key',
        runId: 'run-cache-key',
        previousResponseId: 'resp-prior-should-not-be-sent',
      },
      history: [
        {
          role: 'user',
          content: 'Read README and summarize.',
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: JSON.stringify([
            {
              id: 'call-1',
              name: 'read_file',
              arguments: { path: 'README.md' },
            },
          ]),
          content_blocks: JSON.stringify([
            {
              type: 'responses_output_items',
              items: [
                {
                  id: 'volatile-response-item-id',
                  type: 'reasoning',
                  encrypted_content: 'volatile-encrypted-reasoning-should-not-replay',
                  output_index: 0,
                },
                {
                  id: 'volatile-call-item-id',
                  type: 'function_call',
                  call_id: 'call-from-raw-response-items-should-not-replay',
                  name: 'raw_response_item_tool',
                  arguments: '{"path":"SHOULD_NOT_REPLAY.md"}',
                  output_index: 1,
                },
              ],
            },
          ]),
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: 'README body',
        },
      ],
    })

    expect(result.content).toBe('Final answer after replay')
    expect(capturedBody).toBeTruthy()
    expect(capturedBody.prompt_cache_key).toBe('conversation-cache-key')
    expect(capturedBody.client_metadata).toEqual({ 'x-codex-installation-id': 'conversation-cache-key' })
    expect(capturedBody.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources'])
    expect(capturedBody.service_tier).toBeUndefined()
    expect(capturedBody.previous_response_id).toBeUndefined()
    expect(capturedBody.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message', role: 'user' }),
        expect.objectContaining({ type: 'function_call', call_id: 'call-1', name: 'read_file' }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: expect.stringContaining('README body') }),
      ])
    )
    expect(capturedBody.input).toEqual([
      expect.objectContaining({ type: 'message', role: 'user' }),
      expect.objectContaining({ type: 'function_call', call_id: 'call-1', name: 'read_file' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: expect.stringContaining('README body') }),
    ])
    expect(capturedBody.input).not.toHaveLength(1)
    expect(capturedBody.input).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning' }),
        expect.objectContaining({ call_id: 'call-from-raw-response-items-should-not-replay' }),
        expect.objectContaining({ id: 'volatile-call-item-id' }),
      ])
    )
  })

  it('throws on incomplete responses surfaced by SSE', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0yIn19.sig'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSseStream([
        {
          type: 'response.incomplete',
          response: {
            error: {
              message: 'Provider stopped early',
            },
          },
        },
      ]),
      text: async () => '',
    } as any)

    const provider = new OpenAiChatgptProvider()

    await expect(
      provider.generate({
        modelName: 'gpt-5.2-codex',
        history: [],
        userContent: 'hello',
      })
    ).rejects.toThrow('Provider stopped early')
  })
})
