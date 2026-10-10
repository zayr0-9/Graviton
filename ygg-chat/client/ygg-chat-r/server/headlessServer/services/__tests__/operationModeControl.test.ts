import { describe, expect, it } from 'vitest'
import { OperationModeControl, modeNotificationContent } from '../operationModeControl.js'
import { ToolLoopService } from '../toolLoopService.js'
import { createChatPausingExecutor } from '../chatOrchestrator.js'
import { DecisionBroker } from '../decisionBroker.js'

function harness(control: OperationModeControl, outputs: any[], execute: any, compactBranch?: any) {
  const rows: any[] = []
  const requests: any[] = []
  const sink = {
    persistAssistantMessage(draft: any) {
      const row = { id: `a${rows.length}`, role: 'assistant', parent_id: draft.parentId, content: draft.content,
        content_blocks: JSON.stringify(draft.contentBlocks), tool_calls: JSON.stringify(draft.toolCalls) }
      rows.push(row)
      return row
    },
    updateAssistantToolState(id: string, update: any) {
      const row = rows.find(row => row.id === id)
      row.content_blocks = JSON.stringify(update.contentBlocks)
      row.tool_calls = JSON.stringify(update.toolCalls)
      return row
    },
  }
  const router = { async generate(_provider: string, input: any) {
    requests.push({ ...input, history: [...input.history] })
    const next = outputs.shift()
    return typeof next === 'function' ? next() : next
  } }
  const service = new ToolLoopService({ sink, providerRouter: router as any, executeTool: execute, compactBranch, maxTurns: 4 })
  const input = {
    provider: 'openaichatgpt', modelName: 'test', conversationId: 'c', assistantParentId: 'u',
    history: [{ id: 'u', role: 'user', content: 'task' }], userContent: 'task', systemPrompt: 'stable combined prompt',
    operationMode: control.mode, modeControl: control, autoCompactionEnabled: Boolean(compactBranch), contextLength: 100,
    flushOperationMode(parentId: string | null, history: any[]) {
      let parent = parentId
      return control.flush(history, (mode, previousMode, revision) => {
        const row = { id: `n${rows.length}`, role: 'user', content: modeNotificationContent(mode), parent_id: parent,
          meta: { kind: 'operation_mode_change', mode, previousMode, revision } }
        parent = row.id
        rows.push(row)
        return row
      })
    },
  }
  return { run: () => service.run(input, () => {}), rows, requests, input }
}

describe('live operation mode', () => {
  it('announces the final idle selection after the real user message and before inference', async () => {
    const h = harness(new OperationModeControl('execute'), [{ content: 'done' }], async () => {})
    await h.run()
    expect(h.rows[0]).toMatchObject({ role: 'user', parent_id: 'u', meta: { mode: 'execute' } })
    expect(h.requests[0].history.map((row: any) => row.id)).toEqual(['u', h.rows[0].id])
    expect(h.rows[1].parent_id).toBe(h.rows[0].id)
  })

  it('does not repeat a mode announcement when idle toggles return to the branch mode', async () => {
    const h = harness(new OperationModeControl('plan'), [{ content: 'done' }], async () => {})
    h.input.history.unshift({ id: 'previous-mode', role: 'user', content: modeNotificationContent('plan'), meta: { kind: 'operation_mode_change', mode: 'plan' } } as any)
    await h.run()
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]).toMatchObject({ role: 'assistant', parent_id: 'u' })
  })

  it('leaves a running tool alive, blocks new writes, preserves shell policy, then inserts after results', async () => {
    const control = new OperationModeControl('execute')
    const executed: string[] = []
    const h = harness(control, [
      { content: '', toolCalls: [
        { id: 'one', name: 'edit_file', arguments: {} },
        { id: 'two', name: 'edit_file', arguments: {} },
        { id: 'shell', name: 'bash', arguments: {} },
      ] }, { content: 'done' },
    ], async (call: any) => {
      executed.push(call.id)
      if (call.id === 'one') control.change('plan', 'switch')
      return 'finished normally'
    })
    await h.run()
    expect(executed).toEqual(['one', 'shell'])
    expect(h.rows.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const blocks = JSON.parse(h.rows[1].content_blocks)
    expect(blocks.filter((block: any) => block.type === 'tool_result')).toHaveLength(3)
    expect(blocks.find((block: any) => block.tool_use_id === 'two')?.is_error).toBe(true)
    expect(h.rows[2].parent_id).toBe(h.rows[1].id)
    expect(h.rows[3].parent_id).toBe(h.rows[2].id)
    expect(h.requests[1].history.at(-1).meta.mode).toBe('plan')
    expect(h.requests.map(request => request.systemPrompt)).toEqual(['stable combined prompt', 'stable combined prompt'])
  })

  it('records a switch after a streaming response naturally finishes without another inference', async () => {
    const control = new OperationModeControl('execute')
    const h = harness(control, [() => { control.change('plan', 'switch'); return { content: 'finished' } }], async () => {})
    await h.run()
    expect(h.requests).toHaveLength(1)
    expect(h.rows.at(-1).meta.mode).toBe('plan')
    expect(h.rows.at(-1).parent_id).toBe(h.rows[1].id)
  })

  it('inserts after compaction and restores unchanged modes after history truncation', async () => {
    const control = new OperationModeControl('execute')
    const h = harness(control, [{ content: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: {} }] }, { content: 'done' }],
      async () => 'x'.repeat(1000), async (input: any) => ({ message: {
        id: 'summary', role: 'system', content: 'summary', parent_id: input.parentMessageId, note: '__auto_compaction_summary__',
      } }))
    await h.run()
    expect(h.requests[1].history[0].id).toBe('summary')
    expect(h.requests[1].history.at(-1)).toMatchObject({ role: 'user', parent_id: 'summary', meta: { mode: 'execute' } })
  })

  it('rechecks after a permission await without broadening auto-approval', async () => {
    const control = new OperationModeControl('execute')
    const broker = new DecisionBroker()
    broker.initSession('s', { autoApproveAll: false })
    let called = false
    const execute = createChatPausingExecutor({ modeControl: control, broker, streamId: 's', emit: () => {}, base: async () => { called = true } })
    const pending = execute({ id: 'edit', name: 'edit_file', arguments: {} }, {} as any)
    control.change('plan', 'switch')
    broker.resolve('s', 'edit', 'allow_once')
    await expect(pending).rejects.toThrow('skipped')
    expect(called).toBe(false)
    expect(broker.isAutoApproveAll('s')).toBe(false)
  })

  it('settles obsolete mode/permission waits but not clarification or allowed shell permissions', async () => {
    const broker = new DecisionBroker()
    const upgrade = broker.requestDecision({ streamId: 's', toolCallId: 'upgrade', kind: 'operation_mode_upgrade' })
    const write = broker.requestDecision({ streamId: 's', toolCallId: 'edit', kind: 'permission' })
    const shell = broker.requestDecision({ streamId: 's', toolCallId: 'shell', kind: 'permission' })
    expect(broker.reconcileOperationMode('s', 'plan', new Set(['edit']))).toEqual(['upgrade', 'edit'])
    await expect(upgrade).resolves.toBe('deny')
    await expect(write).resolves.toBe('deny')
    expect(broker.hasPending('s', 'shell')).toBe(true)
    broker.resolve('s', 'shell', 'deny')
    await shell
  })

  it('deduplicates requests, preserves order, and rejects switches after completion', () => {
    const control = new OperationModeControl('execute')
    control.change('plan', 'a')
    control.change('plan', 'a')
    control.change('execute', 'b')
    const transitions: any[] = []
    control.flush([], (mode, previousMode, revision) => { transitions.push({ mode, previousMode, revision }); return {} })
    expect(transitions).toEqual([
      { mode: 'plan', previousMode: 'execute', revision: 1 },
      { mode: 'execute', previousMode: 'plan', revision: 2 },
    ])
    control.closed = true
    expect(() => control.change('plan', 'c')).toThrow('completed')
  })
})

describe('nested calls and prompt-mode upgrade', () => {
  it('blocks nested calls queued after a mode change, including bounded parallel workers', async () => {
    const { createMultiCallDispatchExecutor } = await import('../multiCallExecutor.js')
    const control = new OperationModeControl('execute')
    const executed: string[] = []
    const execute = createMultiCallDispatchExecutor(async call => {
      executed.push(call.id)
      control.change('plan', 'switch')
      return 'already-running call finishes'
    })
    const h = harness(control, [{ content: '', toolCalls: [{ id: 'batch', name: 'multi_call', arguments: {
      parallel: true, maxConcurrency: 1, stopOnError: false,
      calls: [{ tool: 'edit_file' }, { tool: 'edit_file' }, { tool: 'bash' }],
    } }] }, { content: 'done' }], execute)
    await h.run()
    expect(executed).toEqual(['batch:1', 'batch:3'])
    const result = JSON.parse(h.rows[1].content_blocks).find((block: any) => block.type === 'tool_result')
    expect(String(result.content)).toContain('skipped')
  })

  it('uses the same prompt and a durable notification after an approved upgrade', async () => {
    const control = new OperationModeControl('plan')
    const h = harness(control, [{ content: '', toolCalls: [{ id: 'edit', name: 'edit_file', arguments: {} }] }, { content: 'done' }], async () => 'edited')
    Object.assign(h.input, { requestOperationModeUpgrade: async () => { control.change('execute', 'approved'); return true } })
    await h.run()
    expect(h.rows[2].meta.mode).toBe('execute')
    expect(h.requests[0].systemPrompt).toBe(h.requests[1].systemPrompt)
  })
})
