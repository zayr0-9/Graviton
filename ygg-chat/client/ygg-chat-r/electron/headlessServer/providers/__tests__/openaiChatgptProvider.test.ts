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
  })

  it('enables parallel tool calls and preserves final_answer text for gpt-5.3-codex', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig'

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
