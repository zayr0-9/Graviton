import { describe, expect, it, vi } from 'vitest'
import { ToolLoopService } from '../toolLoopService.js'

function setup(executeTool: (call: any, context: any) => Promise<any>) {
  const outputs = [
    { content: '', toolCalls: [{ id: 'provider-1', name: 'bash', arguments: { command: 'sensitive' } }] },
    { content: 'done', toolCalls: [] },
  ]
  const providerRouter = { generate: vi.fn(async () => outputs.shift()) }
  const sink = {
    persistAssistantMessage: vi.fn((draft: any) => ({ id: `m${sink.persistAssistantMessage.mock.calls.length}`, role: 'assistant', content: draft.content, content_blocks: JSON.stringify(draft.contentBlocks), tool_calls: JSON.stringify(draft.toolCalls), parent_id: draft.parentId })),
    updateAssistantToolState: vi.fn((id: string, update: any) => ({ id, role: 'assistant', content: '', content_blocks: JSON.stringify(update.contentBlocks), tool_calls: JSON.stringify(update.toolCalls) })),
  }
  const records: any[] = []
  const toolInvocationRepo = {
    create: vi.fn((input: any) => {
      const row = { id: `inv-${records.length + 1}`, status: 'running', ...input }
      records.push(row)
      return row
    }),
    finish: vi.fn((id: string, patch: any) => Object.assign(records.find(row => row.id === id), patch)),
  }
  const service = new ToolLoopService({ sink, providerRouter: providerRouter as any, executeTool, toolInvocationRepo: toolInvocationRepo as any })
  return { service, records, toolInvocationRepo }
}

const input = {
  provider: 'test', modelName: 'model', conversationId: 'c1', lineageId: 'lin1', streamId: 'stream1',
  assistantParentId: null, history: [], userContent: 'run',
}

describe('ToolLoopService invocation ownership', () => {
  it('creates before execution and completes without persisting args or results', async () => {
    const executeTool = vi.fn(async () => ({ secretResult: 'do not persist' }))
    const { service, records, toolInvocationRepo } = setup(executeTool)
    await service.run(input, () => undefined)
    expect(records[0]).toMatchObject({ id: 'inv-1', lineageId: 'lin1', runId: 'stream1', toolCallId: 'provider-1', toolName: 'bash', status: 'completed' })
    expect(toolInvocationRepo.create.mock.invocationCallOrder[0]).toBeLessThan(executeTool.mock.invocationCallOrder[0])
    expect(JSON.stringify(records)).not.toContain('sensitive')
    expect(JSON.stringify(records)).not.toContain('do not persist')
  })

  it('records failed execution while allowing the loop to continue', async () => {
    const { service, records } = setup(async () => { throw new Error('boom') })
    await service.run(input, () => undefined)
    expect(records[0]).toMatchObject({ status: 'failed', error: 'boom' })
  })
})
