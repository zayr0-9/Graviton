import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/api', () => ({
  buildLocalApiUrl: vi.fn(async (endpoint: string) => `http://127.0.0.1:3002/api${endpoint}`),
  getCachedLocalApiBase: vi.fn(() => 'http://127.0.0.1:3002/api'),
}))

vi.mock('../../helpers/operationModePromptStorage', () => ({
  getSubagentModePrompt: vi.fn(() => ({ prompt: 'DEFAULT PROMPT' })),
}))

vi.mock('../../helpers/subagentModelNames', () => ({
  normalizeSubagentModelName: vi.fn((model: string) => model),
}))

const settings = {
  enabledTools: ['read_file', 'ripgrep'],
  orchestratorEnabled: true,
  maxTurns: 42,
  defaultProvider: null as string | null,
  defaultModel: null as string | null,
  reasoningEffort: 'high' as const,
}

vi.mock('../../helpers/subagentToolSettings', () => ({
  loadSubagentToolSettings: vi.fn(() => settings),
  getSubagentEnabledTools: vi.fn(() => settings.enabledTools),
  getSubagentMaxTurns: vi.fn(() => settings.maxTurns),
  getSubagentReasoningEffort: vi.fn(() => settings.reasoningEffort),
  isOrchestratorEnabled: vi.fn(() => settings.orchestratorEnabled),
}))

vi.mock('./toolDefinitions', () => ({
  getAllTools: vi.fn(() => [
    { name: 'read_file', enabled: true },
    { name: 'ripgrep', enabled: true },
    { name: 'bash', enabled: true },
    { name: 'edit_file', enabled: false },
    { name: 'multi_call', enabled: true },
    { name: 'subagent', enabled: true },
  ]),
}))

import { executeSubagentCall, abortSubagentControllers, resolveSubagentSystemPrompt } from './subagentClient'

const encoder = new TextEncoder()

function sseResponse(frames: string[], opts: { keepOpen?: boolean; signal?: AbortSignal } = {}): any {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    text: async () => '',
    body: {
      getReader() {
        let i = 0
        return {
          async read(): Promise<{ done: boolean; value?: Uint8Array }> {
            if (i < frames.length) {
              return { done: false, value: encoder.encode(frames[i++]) }
            }
            if (opts.keepOpen) {
              // Resolves only when the request signal aborts (abort/stall tests).
              return new Promise((_resolve, reject) => {
                const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
                if (opts.signal?.aborted) return abort()
                opts.signal?.addEventListener('abort', abort, { once: true })
              })
            }
            return { done: true }
          },
          cancel: async () => {},
        }
      },
    },
  }
}

function ev(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const baseContext = () => ({
  conversationId: 'c1',
  parentMessageId: 'p1',
  toolCallId: 'call-1',
  streamId: 'parent-stream',
  rootPath: '/repo',
  operationMode: 'execute' as const,
  callerProvider: 'OpenAI (ChatGPT)',
  queryClient: null,
  getState: null,
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  settings.defaultProvider = null
  settings.defaultModel = null
  settings.orchestratorEnabled = true
})

describe('resolveSubagentSystemPrompt', () => {
  it('joins the default subagent prompt with a custom prompt', () => {
    expect(resolveSubagentSystemPrompt('extra')).toBe('DEFAULT PROMPT\n\nextra')
    expect(resolveSubagentSystemPrompt('')).toBe('DEFAULT PROMPT')
  })
})

describe('executeSubagentCall request building', () => {
  it('builds the request body from tool args + settings', async () => {
    let capturedBody: any = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body)
        return sseResponse([ev({ type: 'complete', result: 'ok' })])
      })
    )

    const result = await executeSubagentCall(
      { id: 'call-1', arguments: { prompt: 'do it', systemPrompt: 'be terse', temperature: 0.5 } },
      baseContext()
    )

    expect(result).toBe('ok')
    expect(capturedBody).toMatchObject({
      conversationId: 'c1',
      parentMessageId: 'p1',
      toolCallId: 'call-1',
      streamId: 'parent-stream',
      prompt: 'do it',
      systemPrompt: 'DEFAULT PROMPT\n\nbe terse',
      provider: 'openaichatgpt',
      modelName: 'gpt-5.6-sol',
      maxTurns: 42,
      reasoningEffort: 'high',
      operationMode: 'execute',
      autoApprove: false,
      rootPath: '/repo',
    })
    // Settings-enabled tools intersected with available; excludes 'subagent' and always includes multi_call.
    expect(capturedBody.tools).toEqual(['read_file', 'ripgrep', 'multi_call'])
    expect(capturedBody.temperature).toBe(0.5)
  })

  it('uses requested tools in orchestrator mode, bypassing the enabled flag', async () => {
    let capturedBody: any = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body)
        return sseResponse([ev({ type: 'complete', result: 'ok' })])
      })
    )

    await executeSubagentCall(
      { id: 'c', arguments: { prompt: 'x', orchestratorMode: true, tools: ['bash', 'edit_file', 'subagent'] } },
      baseContext()
    )

    // edit_file is disabled but requested -> bypass; subagent is excluded and multi_call is required.
    expect(capturedBody.tools).toEqual(['bash', 'edit_file', 'multi_call'])
  })

  it('returns [] tools when the orchestrator is disabled', async () => {
    settings.orchestratorEnabled = false
    let capturedBody: any = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body)
        return sseResponse([ev({ type: 'complete', result: 'ok' })])
      })
    )

    await executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, baseContext())
    expect(capturedBody.tools).toEqual([])
  })

  it('falls back to the local default provider when the caller uses openrouter', async () => {
    let capturedBody: any = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body)
        return sseResponse([ev({ type: 'complete', result: 'ok' })])
      })
    )

    await executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, { ...baseContext(), callerProvider: 'OpenRouter' })
    expect(capturedBody.provider).toBe('openaichatgpt')
    expect(capturedBody.modelName).toBe('gpt-5.6-sol')
  })

  it('captures autoApprove from live state when inheritAutoApprove is set', async () => {
    let capturedBody: any = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body)
        return sseResponse([ev({ type: 'complete', result: 'ok' })])
      })
    )

    const getState = () => ({ chat: { toolAutoApprove: true, providerState: { currentProvider: 'OpenAI (ChatGPT)' }, streaming: { byId: {} } } }) as any
    await executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, { ...baseContext(), getState })
    expect(capturedBody.autoApprove).toBe(true)
  })

  it('throws when no prompt is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(executeSubagentCall({ id: 'c', arguments: {} }, baseContext())).rejects.toThrow('requires a prompt')
  })
})

describe('executeSubagentCall SSE handling', () => {
  it('returns the final text from the complete event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          ev({ type: 'started', subagentRunId: 'r1' }),
          ': heartbeat\n\n',
          ev({ type: 'chunk', part: 'text', delta: 'partial' }),
          ev({ type: 'complete', result: 'the answer' }),
        ])
      )
    )
    const result = await executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, baseContext())
    expect(result).toBe('the answer')
  })

  it('falls back to accumulated text when complete has no result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([ev({ type: 'chunk', part: 'text', delta: 'streamed ' }), ev({ type: 'chunk', part: 'text', delta: 'answer' }), ev({ type: 'complete' })])
      )
    )
    const result = await executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, baseContext())
    expect(result).toBe('streamed answer')
  })

  it('throws the server error from an error event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([ev({ type: 'error', error: 'boom' })])))
    await expect(executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, baseContext())).rejects.toThrow('boom')
  })

  it('throws when the stream ends without a terminal event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([ev({ type: 'chunk', part: 'text', delta: 'x' })])))
    await expect(executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, baseContext())).rejects.toThrow(
      'without a terminal event'
    )
  })

  it('throws on a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'server error' })))
    await expect(executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, baseContext())).rejects.toThrow('HTTP 500')
  })

  it('aborts when abortSubagentControllers is called for the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) =>
        sseResponse([ev({ type: 'started', subagentRunId: 'r1' })], { keepOpen: true, signal: init.signal })
      )
    )
    const promise = executeSubagentCall({ id: 'c', arguments: { prompt: 'x' } }, baseContext())
    const assertion = expect(promise).rejects.toThrow('Subagent aborted')
    await new Promise(resolve => setTimeout(resolve, 20))
    abortSubagentControllers('parent-stream')
    await assertion
  })
})
