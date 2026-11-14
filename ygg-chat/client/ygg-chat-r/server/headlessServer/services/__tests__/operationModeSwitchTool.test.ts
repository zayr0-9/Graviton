import { describe, expect, it } from 'vitest'
import { OperationModeControl, modeNotificationContent } from '../operationModeControl.js'
import { createOperationModeSwitchExecutor, createOperationModeSwitcher } from '../operationModeSwitchTool.js'
import { createMultiCallDispatchExecutor } from '../multiCallExecutor.js'
import { ToolLoopService, type ToolExecutor } from '../toolLoopService.js'

const call = (mode: string, id = 'switch') => ({ id, name: 'switch_mode', arguments: { mode, reason: 'because' } })

describe('switch_mode switcher', () => {
  it('switches Agent -> Chat at once, without asking the user', async () => {
    const control = new OperationModeControl('execute')
    let asked = 0
    const switcher = createOperationModeSwitcher({ control, requestUpgrade: async () => { asked++; return true }, userInputCount: () => 0 })
    await expect(switcher(call('chat'), 'plan')).resolves.toMatchObject({ mode: 'chat', changed: true })
    expect(control.mode).toBe('plan')
    expect(control.revision).toBe(1)
    expect(asked).toBe(0)
  })

  it('asks the user before Chat -> Agent and switches only on approval', async () => {
    const control = new OperationModeControl('plan')
    const asked: string[] = []
    const switcher = createOperationModeSwitcher({
      control,
      requestUpgrade: async toolCall => { asked.push(toolCall.id); control.change('execute', `upgrade:${toolCall.id}`); return true },
      userInputCount: () => 0,
    })
    await expect(switcher(call('agent'), 'execute')).resolves.toMatchObject({ mode: 'agent', changed: true })
    expect(asked).toEqual(['switch'])
    expect(control.mode).toBe('execute')
  })

  it('does not ask again after a decline until new user input arrives', async () => {
    const control = new OperationModeControl('plan')
    let asked = 0
    let inputs = 0
    const switcher = createOperationModeSwitcher({ control, requestUpgrade: async () => { asked++; return false }, userInputCount: () => inputs })
    await expect(switcher(call('agent', 'a'), 'execute')).resolves.toMatchObject({ mode: 'chat', changed: false, declined: true })
    await expect(switcher(call('agent', 'b'), 'execute')).resolves.toMatchObject({ declined: true, message: expect.stringContaining('already declined') })
    expect(asked).toBe(1)
    inputs = 1
    await switcher(call('agent', 'c'), 'execute')
    expect(asked).toBe(2)
    expect(control.mode).toBe('plan')
  })

  it('is a no-op when already in the requested mode', async () => {
    const control = new OperationModeControl('plan')
    const switcher = createOperationModeSwitcher({ control, userInputCount: () => 0 })
    await expect(switcher(call('chat'), 'plan')).resolves.toMatchObject({ mode: 'chat', changed: false })
    expect(control.revision).toBe(0)
  })

  it('fails when the run cannot ask the user for Agent mode', async () => {
    const control = new OperationModeControl('plan')
    const switcher = createOperationModeSwitcher({ control, userInputCount: () => 0 })
    await expect(switcher(call('agent'), 'execute')).rejects.toThrow('needs user approval')
    expect(control.mode).toBe('plan')
  })
})

describe('switch_mode executor', () => {
  const leaf: ToolExecutor = async toolCall => `leaf:${toolCall.name}`

  it('passes other tools through to the leaf executor', async () => {
    await expect(createOperationModeSwitchExecutor(leaf)({ id: 'r', name: 'read_file', arguments: {} }, { conversationId: 'c', messageId: 'm' }))
      .resolves.toBe('leaf:read_file')
  })

  it('maps chat/agent onto plan/execute and rejects anything else', async () => {
    const requested: string[] = []
    const execute = createOperationModeSwitchExecutor(leaf)
    const context = {
      conversationId: 'c', messageId: 'm',
      switchOperationMode: async (_toolCall: any, mode: any) => { requested.push(mode); return { mode, changed: true, message: '' } as any },
    }
    await execute(call('agent'), context)
    await execute({ id: 's', name: 'switch_mode', arguments: '{"mode":"Chat","reason":"x"}' }, context)
    expect(requested).toEqual(['execute', 'plan'])
    await expect(execute(call('readonly'), context)).rejects.toThrow('mode "chat" or "agent"')
  })

  it('fails outside a run with live mode control (subagents, direct calls)', async () => {
    await expect(createOperationModeSwitchExecutor(leaf)(call('chat'), { conversationId: 'c', messageId: 'm' }))
      .rejects.toThrow('only available in a main chat run')
  })

  it('cannot be nested inside multi_call', async () => {
    const execute = createMultiCallDispatchExecutor(createOperationModeSwitchExecutor(leaf))
    await expect(execute({ id: 'b', name: 'multi_call', arguments: { calls: [{ tool: 'switch_mode', args: { mode: 'agent', reason: 'x' } }] } },
      { conversationId: 'c', messageId: 'm' })).rejects.toThrow('cannot invoke nested tool: switch_mode')
  })
})

/** Minimal in-memory loop harness with the real mode-notification flush. */
function harness(control: OperationModeControl, outputs: any[], leaf: ToolExecutor) {
  const rows: any[] = []
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
  const router = { async generate() { return outputs.shift() } }
  const service = new ToolLoopService({ sink: sink as any, providerRouter: router as any, executeTool: createOperationModeSwitchExecutor(leaf), maxTurns: 4 })
  const input: any = {
    provider: 'openaichatgpt', modelName: 'test', conversationId: 'c', assistantParentId: 'u',
    history: [{ id: 'u', role: 'user', content: 'task' }], userContent: 'task', systemPrompt: 'prompt',
    operationMode: control.mode, modeControl: control,
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
  const toolResult = (id: string) => rows.flatMap(row => row.role === 'assistant' ? JSON.parse(row.content_blocks || '[]') : [])
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id)
  return { run: () => service.run(input, () => {}), rows, input, toolResult }
}

describe('switch_mode in the tool loop', () => {
  it('upgrades through the approval prompt, records the notice, then runs Agent tools', async () => {
    const control = new OperationModeControl('plan')
    const executed: Array<{ name: string; mode?: string }> = []
    const h = harness(control, [
      { content: '', toolCalls: [call('agent')] },
      { content: '', toolCalls: [{ id: 'edit', name: 'edit_file', arguments: {} }] },
      { content: 'done' },
    ], async (toolCall, context) => { executed.push({ name: toolCall.name, mode: context.operationMode }); return 'edited' })
    const prompted: string[] = []
    h.input.requestOperationModeUpgrade = async (toolCall: any) => {
      prompted.push(toolCall.name)
      control.change('execute', `upgrade:${toolCall.id}`)
      return true
    }
    await h.run()
    expect(prompted).toEqual(['switch_mode'])
    expect(h.rows.find(row => row.meta?.kind === 'operation_mode_change' && row.meta.revision === 1)?.meta).toMatchObject({ mode: 'execute', previousMode: 'plan' })
    expect(executed).toEqual([{ name: 'edit_file', mode: 'execute' }])
    expect(JSON.parse(String(h.toolResult('switch').content))).toMatchObject({ mode: 'agent', changed: true })
  })

  it('downgrades without a prompt and skips Agent tools later in the same batch', async () => {
    const control = new OperationModeControl('execute')
    const executed: string[] = []
    const h = harness(control, [
      { content: '', toolCalls: [call('chat'), { id: 'edit', name: 'edit_file', arguments: {} }] },
      { content: 'done' },
    ], async toolCall => { executed.push(toolCall.name); return 'edited' })
    h.input.requestOperationModeUpgrade = async () => { throw new Error('must not prompt for a downgrade') }
    await h.run()
    expect(control.mode).toBe('plan')
    expect(executed).toEqual([])
    expect(String(h.toolResult('edit').content)).toContain('skipped')
    expect(h.rows.find(row => row.meta?.kind === 'operation_mode_change' && row.meta.revision === 1)?.meta).toMatchObject({ mode: 'plan', previousMode: 'execute' })
  })
})
