import { describe, expect, it, vi } from 'vitest'
import { createSubagentDispatchExecutor } from '../subagentToolExecutor.js'

const context = (overrides: Record<string, any> = {}) => ({
  conversationId: 'conversation-1',
  messageId: 'assistant-tool-message',
  streamId: 'parent-stream',
  rootPath: '/workspace',
  operationMode: 'execute' as const,
  provider: 'openaichatgpt',
  modelName: 'gpt-5.6-sol',
  autoApprove: true,
  subagentReasoningEffort: 'high' as const,
  signal: new AbortController().signal,
  ...overrides,
})

describe('createSubagentDispatchExecutor', () => {
  it('delegates ordinary tools to the leaf executor', async () => {
    const leafExecutor = vi.fn(async () => 'leaf result')
    const runForTool = vi.fn()
    const execute = createSubagentDispatchExecutor({ leafExecutor, subagentRunner: { runForTool } })

    await expect(execute({ id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } }, context())).resolves.toBe(
      'leaf result'
    )
    expect(leafExecutor).toHaveBeenCalledOnce()
    expect(runForTool).not.toHaveBeenCalled()
  })

  it('runs subagent in-process with parent correlation and explicit orchestrator tools', async () => {
    const leafExecutor = vi.fn()
    const runForTool = vi.fn(async () => 'scout report')
    const execute = createSubagentDispatchExecutor({ leafExecutor, subagentRunner: { runForTool } })

    const result = await execute(
      {
        id: 'sub-1',
        name: 'subagent',
        arguments: {
          prompt: 'Scout the stream code',
          systemPrompt: 'Report facts only',
          temperature: 0.2,
          orchestratorMode: true,
          tools: ['read_file', 'ripgrep', 'subagent'],
          inheritAutoApprove: true,
        },
      },
      context({ operationMode: 'plan' })
    )

    expect(result).toBe('scout report')
    expect(leafExecutor).not.toHaveBeenCalled()
    expect(runForTool).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        parentMessageId: 'assistant-tool-message',
        toolCallId: 'sub-1',
        streamId: 'parent-stream',
        prompt: 'Scout the stream code',
        systemPrompt: expect.stringContaining('Report facts only'),
        provider: 'openaichatgpt',
        modelName: 'gpt-5.6-sol',
        tools: ['read_file', 'ripgrep', 'multi_call'],
        temperature: 0.2,
        reasoningEffort: 'high',
        operationMode: 'plan',
        autoApprove: true,
        rootPath: '/workspace',
      }),
      expect.any(AbortSignal)
    )
  })

  it('uses server defaults when orchestrator mode is off and honors inherited approval denial', async () => {
    const runForTool = vi.fn(async () => 'done')
    const execute = createSubagentDispatchExecutor({ leafExecutor: vi.fn(), subagentRunner: { runForTool } })

    await execute(
      {
        id: 'sub-2',
        name: 'subagent',
        arguments: { prompt: 'Scout', orchestratorMode: false, tools: ['bash'], inheritAutoApprove: false },
      },
      context()
    )

    const request = runForTool.mock.calls[0][0]
    expect(request.tools).toBeUndefined()
    expect(request.autoApprove).toBe(false)
  })

  it('falls OpenRouter parents back to the local subagent provider', async () => {
    const runForTool = vi.fn(async () => 'done')
    const execute = createSubagentDispatchExecutor({ leafExecutor: vi.fn(), subagentRunner: { runForTool } })

    await execute(
      { id: 'sub-3', name: 'subagent', arguments: { prompt: 'Scout' } },
      context({ provider: 'openrouter', modelName: 'cloud-model' })
    )

    expect(runForTool.mock.calls[0][0]).toMatchObject({ provider: 'openaichatgpt', modelName: 'gpt-5.6-sol' })
  })

  it('rejects missing prompts before starting a child run', async () => {
    const runForTool = vi.fn()
    const execute = createSubagentDispatchExecutor({ leafExecutor: vi.fn(), subagentRunner: { runForTool } })

    await expect(execute({ id: 'sub-4', name: 'subagent', arguments: {} }, context())).rejects.toThrow(
      'Subagent requires a prompt'
    )
    expect(runForTool).not.toHaveBeenCalled()
  })
})
