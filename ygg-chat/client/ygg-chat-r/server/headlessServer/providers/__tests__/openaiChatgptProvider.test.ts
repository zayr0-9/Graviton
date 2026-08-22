import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OPENAI_CHATGPT_CONTEXT_LENGTH,
  OpenAiChatgptProvider,
  normalizeOpenAIChatGPTModel,
  resolveOpenAIChatGPTContextLength,
} from '../openaiChatgptProvider.js'

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
  it('resolves the global ChatGPT context override with defaults and bounds', () => {
    delete process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS
    expect(resolveOpenAIChatGPTContextLength()).toBe(DEFAULT_OPENAI_CHATGPT_CONTEXT_LENGTH)
    expect(resolveOpenAIChatGPTContextLength(64_000)).toBe(64_000)

    process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = '96000'
    expect(resolveOpenAIChatGPTContextLength()).toBe(96_000)
    expect(resolveOpenAIChatGPTContextLength(64_000)).toBe(64_000)

    process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = '100'
    expect(resolveOpenAIChatGPTContextLength()).toBe(1_000)
    process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS = '9999999'
    expect(resolveOpenAIChatGPTContextLength()).toBe(2_000_000)
  })

  it('normalizes ChatGPT display labels to backend model IDs', () => {
    expect(normalizeOpenAIChatGPTModel('GPT-5.6 Sol')).toBe('gpt-5.6-sol')
    expect(normalizeOpenAIChatGPTModel('GPT-5.6 Terra')).toBe('gpt-5.6-terra')
    expect(normalizeOpenAIChatGPTModel('GPT-5.6 Luna')).toBe('gpt-5.6-luna')
    expect(normalizeOpenAIChatGPTModel('GPT-5.4 Mini')).toBe('gpt-5.4-mini')
    expect(normalizeOpenAIChatGPTModel('openaichatgpt/GPT-5.4 Mini')).toBe('gpt-5.4-mini')
    expect(normalizeOpenAIChatGPTModel('GPT-5.4 Pro')).toBe('gpt-5.4-pro')
    expect(normalizeOpenAIChatGPTModel('GPT-5.3 Codex')).toBe('gpt-5.3-codex')
  })

  it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'enables Responses Lite transport for %s',
    async modelName => {
      process.env.OPENAI_CHATGPT_ACCESS_TOKEN =
        'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC01NiJ9fQ.sig'

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body || '{}'))
        const headers = new Headers(init?.headers as any)
        expect(body.model).toBe(modelName)
        expect(body.instructions).toBeUndefined()
        expect(body.tools).toBeUndefined()
        expect(body.tool_choice).toBe('auto')
        expect(body.parallel_tool_calls).toBe(false)
        expect(body.reasoning.context).toBe('all_turns')
        expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        expect(headers.get('session-id')).toBe(body.prompt_cache_key)
        expect(headers.get('thread-id')).toBe(body.prompt_cache_key)
        expect(headers.get('x-session-affinity')).toBe(body.prompt_cache_key)
        expect(headers.get('version')).toBe('0.144.0')
        expect(body.input[0]).toEqual(expect.objectContaining({ type: 'additional_tools', role: 'developer' }))
        expect(body.input[1]).toEqual({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'You are ChatGPT.' }],
        })
        expect(headers.get('x-openai-internal-codex-responses-lite')).toBe('true')

        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: createSseStream([
            {
              type: 'response.completed',
              response: {
                id: `resp-${modelName}`,
                output: [
                  {
                    id: 'msg-final',
                    type: 'message',
                    role: 'assistant',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: 'ok' }],
                  },
                ],
              },
            },
          ]),
          text: async () => '',
        } as any
      })

      const provider = new OpenAiChatgptProvider()
      const conversationId = `non-uuid-${modelName}`
      const result = await provider.generate({
        modelName,
        history: [],
        userContent: 'hello',
        railwayTurn: { conversationId } as any,
      })
      expect(result.content).toBe('ok')
    }
  )

  it('does not use commentary-only text as provider content by default', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1jb21tZW50YXJ5In19.sig'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSseStream([
        {
          type: 'response.output_item.added',
          item: { id: 'msg-commentary', type: 'message', role: 'assistant', phase: 'commentary' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-commentary',
          delta: 'COMMENTARY_ONLY_TEXT',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-commentary-default',
            output: [
              {
                id: 'msg-commentary',
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                content: [],
              },
            ],
          },
        },
      ]),
      text: async () => '',
    } as any)

    const provider = new OpenAiChatgptProvider()
    const result = await provider.generate({ modelName: 'gpt-5.4-mini', history: [], userContent: 'hello' })

    expect(result.content).toBe('')
  })

  it('uses commentary-only text as provider content when fallback is opted in', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1jb21tZW50YXJ5In19.sig'

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSseStream([
        {
          type: 'response.output_item.added',
          item: { id: 'msg-commentary', type: 'message', role: 'assistant', phase: 'commentary' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg-commentary',
          delta: 'VISIBLE_TEXT_OK',
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-commentary-opt-in',
            output: [
              {
                id: 'msg-commentary',
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                content: [],
              },
            ],
          },
        },
      ]),
      text: async () => '',
    } as any)

    const provider = new OpenAiChatgptProvider()
    const result = await provider.generate({
      modelName: 'gpt-5.4-mini',
      history: [],
      userContent: 'hello',
      railwayTurn: { conversationId: 'ephemeral-test', allowCommentaryFallbackText: true },
    })

    expect(result.content).toBe('VISIBLE_TEXT_OK')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.OPENAI_CHATGPT_ACCESS_TOKEN
    delete process.env.OPENAI_ACCESS_TOKEN
    delete process.env.OPENAI_CHATGPT_ACCOUNT_ID
    delete process.env.YGG_OPENAI_CHATGPT_DEBUG_LOGS
    delete process.env.YGG_OPENAI_CHATGPT_MAX_CONTEXT_TOKENS
    delete process.env.YGG_CODEX_DEV_LOGS
  })

  it('enables parallel tool calls and preserves final_answer text for gpt-5.3-codex', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig'
    process.env.YGG_CODEX_DEV_LOGS = 'true'

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const headers = new Headers(init?.headers as any)
      expect(body.instructions).toBe('You are ChatGPT.')
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

  it('dedupes reasoning persisted from deltas and completed output items', async () => {
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC1yZWFzb24ifX0.sig'

    const shortReasoning = [
      'Planning file inspection',
      '',
      'I’ve decided need to focus mode and inspecting files. It seems like important step wonder what’ll discover during this how will help with my tasks want ensure approach carefully thoroughly, checking everything that\'s relevant I\'ll make keep the process organized not overlook any details could be significant Let’s get started!',
    ].join('\n')
    const fullReasoning = [
      'Planning file inspection',
      '',
      'I’ve decided I need to focus on planning mode and inspecting files. It seems like an important step. I wonder what I’ll discover during this inspection and how it will help with my tasks. I want to ensure I approach this carefully and thoroughly, checking everything that\'s relevant. I\'ll make sure to keep the process organized and not overlook any details that could be significant. Let’s get started!',
    ].join('\n')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: createSseStream([
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs-1',
          summary_index: 0,
          delta: shortReasoning,
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp-reasoning',
            output: [
              {
                id: 'rs-1',
                type: 'reasoning',
                output_index: 0,
                encrypted_content: 'keep-encrypted-reasoning-metadata',
                summary: [{ type: 'summary_text', text: fullReasoning }],
              },
              {
                id: 'msg-final',
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                output_index: 1,
                content: [{ type: 'output_text', text: 'Done.' }],
              },
            ],
          },
        },
      ]),
      text: async () => '',
    } as any)

    const provider = new OpenAiChatgptProvider()
    const result = await provider.generate({
      modelName: 'gpt-5.5',
      history: [],
      userContent: 'Inspect files',
    })

    expect(result.reasoning).toBe(fullReasoning)
    expect(result.reasoning).not.toContain(`${shortReasoning}\n\n${fullReasoning}`)

    const thinkingBlocks = (result.contentBlocks || []).filter((block: any) => block?.type === 'thinking')
    expect(thinkingBlocks).toHaveLength(1)
    expect(thinkingBlocks[0]).toEqual({ type: 'thinking', content: fullReasoning })

    const responsesBlock = (result.contentBlocks || []).find((block: any) => block?.type === 'responses_output_items') as any
    const reasoningItem = responsesBlock?.items?.find((item: any) => item?.type === 'reasoning')
    expect(reasoningItem).toEqual(expect.objectContaining({ encrypted_content: 'keep-encrypted-reasoning-metadata' }))
    expect(reasoningItem?.summary?.[0]?.text).toBeUndefined()
    expect(JSON.stringify(result.raw?.responses_output_items)).not.toContain(fullReasoning)
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
    expect(capturedBody.instructions).toBe('You are ChatGPT.')
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

  it('retries ChatGPT HTTP 429 setup failures three times before surfacing the final usage-limit error', async () => {
    vi.useFakeTimers()
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC00In19.sig'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorBody = '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1782168563}}'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
      text: async () => errorBody,
    }) as any)

    const provider = new OpenAiChatgptProvider()
    const promise = expect(
      provider.generate({
        modelName: 'gpt-5.4-mini',
        history: [],
        userContent: 'hello',
      })
    ).rejects.toThrow('usage_limit_reached')

    await vi.runAllTimersAsync()
    await promise

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(warnSpy).toHaveBeenCalledWith(
      '[headless-stream-resilience] pre-first-byte retry event',
      expect.objectContaining({
        endpoint: '/backend-api/codex/responses',
        maxRetries: 3,
        failureClass: 'retryable_status',
        status: 429,
      })
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[Codex HTTP] non-OK response',
      expect.objectContaining({
        status: 429,
        bodyPreview: expect.stringContaining('usage_limit_reached'),
      })
    )
  })
  it('retries ChatGPT HTTP stream setup three times before succeeding', async () => {
    vi.useFakeTimers()
    process.env.OPENAI_CHATGPT_ACCESS_TOKEN = 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC00In19.sig'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (fetchMock.mock.calls.length <= 3) {
        throw new TypeError('fetch failed')
      }

      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: createSseStream([
          {
            type: 'response.completed',
            response: {
              id: 'resp-retried',
              output: [
                {
                  id: 'msg-final',
                  type: 'message',
                  role: 'assistant',
                  phase: 'final_answer',
                  output_index: 0,
                  content: [{ type: 'output_text', text: 'Recovered after retries' }],
                },
              ],
            },
          },
        ]),
        text: async () => '',
      } as any
    })

    const provider = new OpenAiChatgptProvider()
    const promise = provider.generate({
      modelName: 'gpt-5.5',
      history: [],
      userContent: 'hello',
    })

    await vi.runAllTimersAsync()
    const result = await promise

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result.content).toBe('Recovered after retries')
    expect(warnSpy).toHaveBeenCalledTimes(3)
    expect(warnSpy).toHaveBeenCalledWith(
      '[headless-stream-resilience] pre-first-byte retry event',
      expect.objectContaining({
        endpoint: '/backend-api/codex/responses',
        maxRetries: 3,
        failureClass: 'request_error',
        error: 'fetch failed',
      })
    )
  })
})
