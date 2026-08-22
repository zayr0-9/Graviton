import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCustomToolRegistry } = vi.hoisted(() => ({
  mockCustomToolRegistry: {
    initialize: vi.fn(),
    getStatuses: vi.fn(),
    getDefinitions: vi.fn(),
    setToolEnabled: vi.fn(),
    addToolFromDirectory: vi.fn(),
    removeTool: vi.fn(),
    reload: vi.fn(),
    updateSettings: vi.fn(),
    getSettings: vi.fn(),
    executeTool: vi.fn(),
  },
}))

vi.mock('../customToolLoader.js', () => ({
  customToolRegistry: mockCustomToolRegistry,
}))

import { execute } from '../customToolManager.js'

const makeDefinition = (overrides: Record<string, any> = {}) => ({
  name: 'example_tool',
  enabled: true,
  description: 'Example tool for testing.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      mode: { type: 'string', enum: ['headless', 'ui'] },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['query'],
  },
  isCustom: true,
  sourcePath: '/tmp/example_tool',
  directoryName: 'example_tool',
  ...overrides,
})

describe('customToolManager invoke action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCustomToolRegistry.initialize.mockResolvedValue(undefined)
    mockCustomToolRegistry.getStatuses.mockReturnValue([])
    mockCustomToolRegistry.getDefinitions.mockReturnValue([])
    mockCustomToolRegistry.getSettings.mockReturnValue({ autoRefresh: true, refreshDebounceMs: 500 })
    mockCustomToolRegistry.executeTool.mockResolvedValue({ success: true })
  })

  it('returns a structured error when invoke name is missing', async () => {
    const result = await execute({ action: 'invoke' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('requires a "name"')
    expect(mockCustomToolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('returns a structured error when invoked tool is unknown', async () => {
    mockCustomToolRegistry.getDefinitions.mockReturnValue([makeDefinition({ name: 'other_tool' })])

    const result = await execute({ action: 'invoke', name: 'missing_tool', args: { query: 'x' } })

    expect(result.success).toBe(false)
    expect(result.invokedToolName).toBe('missing_tool')
    expect(result.error).toContain('not found')
    expect(mockCustomToolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('returns a structured error when invoked tool is disabled', async () => {
    mockCustomToolRegistry.getDefinitions.mockReturnValue([makeDefinition({ name: 'disabled_tool', enabled: false })])

    const result = await execute({ action: 'invoke', name: 'disabled_tool', args: { query: 'x' } })

    expect(result.success).toBe(false)
    expect(result.error).toContain('disabled')
    expect(result.invokedToolName).toBe('disabled_tool')
    expect(mockCustomToolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('blocks invoke when args are invalid and returns retry guidance', async () => {
    mockCustomToolRegistry.getDefinitions.mockReturnValue([makeDefinition({ name: 'validate_tool' })])

    const result = await execute({ action: 'invoke', name: 'validate_tool', args: { mode: 'headless' } })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid arguments')
    expect(Array.isArray(result.validationErrors)).toBe(true)
    expect((result.validationErrors || []).length).toBeGreaterThan(0)
    expect(result.expectedSchemaHint).toContain('required')
    expect(result.retryInstruction).toContain('invoke')
    expect(mockCustomToolRegistry.executeTool).not.toHaveBeenCalled()
  })

  it('executes invoke with context options when args are valid', async () => {
    mockCustomToolRegistry.getDefinitions.mockReturnValue([makeDefinition({ name: 'context_tool' })])
    mockCustomToolRegistry.executeTool.mockResolvedValue({ success: true, content: 'done' })

    const options = {
      rootPath: '/workspace',
      operationMode: 'execute' as const,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      streamId: 'stream-1',
    }

    const result = await execute({ action: 'invoke', name: 'context_tool', args: { query: 'hello' } }, options)

    expect(mockCustomToolRegistry.executeTool).toHaveBeenCalledWith('context_tool', { query: 'hello' }, options)
    expect(result.success).toBe(true)
    expect(result.invokedToolName).toBe('context_tool')
    expect(result.invokedVia).toBe('custom_tool_manager')
    expect((result as any).content).toBe('done')
  })

  it('stamps toolName for html invoke results when missing', async () => {
    mockCustomToolRegistry.getDefinitions.mockReturnValue([makeDefinition({ name: 'html_tool' })])
    mockCustomToolRegistry.executeTool.mockResolvedValue({ success: true, html: '<html></html>' })

    const result = await execute({ action: 'invoke', name: 'html_tool', args: { query: 'hello' } })

    expect(result.success).toBe(true)
    expect((result as any).toolName).toBe('html_tool')
  })

  it('stamps toolName for typed html invoke results when missing', async () => {
    mockCustomToolRegistry.getDefinitions.mockReturnValue([makeDefinition({ name: 'typed_html_tool' })])
    mockCustomToolRegistry.executeTool.mockResolvedValue({
      success: true,
      type: 'text/html',
      content: '<html></html>',
    })

    const result = await execute({ action: 'invoke', name: 'typed_html_tool', args: { query: 'hello' } })

    expect(result.success).toBe(true)
    expect((result as any).toolName).toBe('typed_html_tool')
  })
})

describe('customToolManager non-invoke actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCustomToolRegistry.initialize.mockResolvedValue(undefined)
  })

  it('keeps list action behavior unchanged', async () => {
    mockCustomToolRegistry.getStatuses.mockReturnValue([
      {
        name: 'everything_search',
        description: 'Lightning-fast file search using Everything Search Engine.',
        enabled: true,
        loaded: true,
        directoryName: 'everything_search',
      },
    ])

    const result = await execute({ action: 'list' })

    expect(result.success).toBe(true)
    expect(result.totalCount).toBe(1)
    expect((result.tools || [])[0]?.name).toBe('everything_search')
  })
})
