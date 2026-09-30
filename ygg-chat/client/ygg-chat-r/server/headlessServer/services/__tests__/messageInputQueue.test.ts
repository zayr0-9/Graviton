import { describe, expect, it } from 'vitest'
import { MessageInputQueue } from '../messageInputQueue.js'
import { OperationModeControl } from '../operationModeControl.js'
import { ToolLoopService } from '../toolLoopService.js'
import { toCodexMessages } from '../../providers/codex/codexRequestItems.js'

const makeQueue = () => new MessageInputQueue('s', 'c', 'l', () => {})

describe('MessageInputQueue', () => {
  it('deduplicates, claims FIFO, cancels only before delivery, and orders mode revisions', () => {
    const queue = makeQueue()
    queue.enqueue({ requestId: 'one', content: 'first' }, 0)
    queue.enqueue({ requestId: 'one', content: 'first' }, 0)
    queue.enqueue({ requestId: 'two', content: 'second' }, 1)
    queue.enqueue({ requestId: 'three', content: 'third' }, 2)
    expect(queue.tryClose()).toBe(false)
    expect(queue.cancel('two')).toBe(true)
    const first = queue.claim()!
    expect(first.submission.content).toBe('first')
    expect(first.modeRevision).toBe(0)
    expect(queue.cancel('one')).toBe(false)
    queue.settle('one', { messageId: 'u1' })
    expect(queue.claim()?.submission.requestId).toBe('three')
    queue.settle('three', { messageId: 'u3' })
    expect(queue.tryClose()).toBe(true)
    expect(() => queue.enqueue({ requestId: 'late', content: 'late' }, 2)).toThrow('no longer')
    expect(queue.enqueue({ requestId: 'one', content: 'first' }, 0).messageId).toBe('u1')
  })

  it('keeps unprocessed text visible after stop/error, and snapshots contain no image bytes', () => {
    const queue = makeQueue()
    queue.enqueue({ requestId: 'one', content: 'keep me', attachmentsBase64: [{ dataUrl: 'data:image/png;base64,AAA' }] }, 0)
    expect(JSON.stringify(queue.snapshot())).not.toContain('base64')
    queue.failRemaining('Stopped')
    expect(queue.snapshot().items[0]).toMatchObject({ status: 'failed', content: 'keep me', error: 'Stopped', attachmentCount: 1 })
  })

  it('flushes only mode changes accepted before a queued message', () => {
    const mode = new OperationModeControl('plan')
    mode.change('execute', 'm1')
    mode.change('plan', 'm2')
    const rows: any[] = []
    mode.flush([], (value, _, revision) => { rows.push([value, revision]); return {} }, 1)
    expect(rows).toEqual([['execute', 1]])
    mode.flush([], (value, _, revision) => { rows.push([value, revision]); return {} })
    expect(rows).toEqual([['execute', 1], ['plan', 2]])
  })
})

function loopHarness(opts: { outputs: any[]; onProvider?: (call: number, queue: MessageInputQueue) => void; onTool?: (queue: MessageInputQueue) => void; compact?: boolean }) {
  const queue = makeQueue()
  const persisted: any[] = []
  const requests: any[] = []
  const sink = {
    persistAssistantMessage(draft: any) {
      const row = { id: `a${persisted.length}`, role: 'assistant', content: draft.content, parent_id: draft.parentId,
        content_blocks: JSON.stringify(draft.contentBlocks), tool_calls: JSON.stringify(draft.toolCalls) }
      persisted.push(row)
      return row
    },
    updateAssistantToolState(id: string, update: any) {
      const row = persisted.find(row => row.id === id)
      row.content_blocks = JSON.stringify(update.contentBlocks)
      row.tool_calls = JSON.stringify(update.toolCalls)
      return row
    },
  }
  const loop = new ToolLoopService({ sink, maxTurns: 5,
    providerRouter: { async generate(_provider: string, input: any) {
      requests.push({ ...input, history: [...input.history] })
      opts.onProvider?.(requests.length, queue)
      return opts.outputs.shift() ?? { content: 'done' }
    } } as any,
    executeTool: async () => { opts.onTool?.(queue); return 'x'.repeat(1000) },
    compactBranch: opts.compact ? async input => ({ message: { id: 'summary', role: 'system', content: 'summary',
      parent_id: input.parentMessageId, note: '__auto_compaction_summary__' } }) : undefined,
  })
  const run = () => loop.run({
    provider: 'openaichatgpt', modelName: 'test', conversationId: 'c', assistantParentId: 'u',
    history: [{ id: 'u', role: 'user', content: 'original' }], userContent: 'original',
    systemPrompt: 'stable', autoCompactionEnabled: opts.compact ?? false, contextLength: 100,
    robustness: { finalizeOnSilentToolEnd: true },
    closeInputQueue: () => queue.tryClose(),
    flushQueuedMessages: async (parentId, history) => {
      const rows: any[] = []
      let parent = parentId
      let item = queue.claim()
      while (item) {
        // The whole assistant/tool batch must be durable before a new user row.
        const previousAssistant = [...history].reverse().find(row => row.role === 'assistant')
        if (previousAssistant?.tool_calls && JSON.parse(previousAssistant.tool_calls)?.length) {
          const blocks = JSON.parse(previousAssistant.content_blocks)
          expect(blocks.some((block: any) => block.type === 'tool_result')).toBe(true)
        }
        const row = { id: item.submission.requestId, role: 'user', content: item.submission.content, parent_id: parent,
          attachments: item.submission.attachmentsBase64 }
        rows.push(row); persisted.push(row); parent = row.id
        queue.settle(item.submission.requestId, { messageId: row.id })
        item = queue.claim()
      }
      return { rows, delivered: rows.length }
    },
  }, () => {})
  return { run, queue, persisted, requests }
}

describe('queued input safe boundaries', () => {
  it('continues after a natural answer and batches FIFO user rows into one inference', async () => {
    const h = loopHarness({ outputs: [{ content: 'first answer' }, { content: 'follow-up answer' }], onProvider(call, queue) {
      if (call === 1) {
        queue.enqueue({ requestId: 'q1', content: 'follow up one' }, 0)
        queue.enqueue({ requestId: 'q2', content: 'follow up two' }, 0)
      }
    } })
    await h.run()
    expect(h.persisted.map(row => row.role)).toEqual(['assistant', 'user', 'user', 'assistant'])
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].history.slice(-2).map((row: any) => row.id)).toEqual(['q1', 'q2'])
    expect(h.persisted.at(-1).parent_id).toBe('q2')
    expect(h.queue.closed).toBe(true)
  })

  it('accepts input while a silent-answer finalization is running', async () => {
    const h = loopHarness({ outputs: [
      { content: '', toolCalls: [{ id: 'tool', name: 'read_file', arguments: {} }] },
      { content: '' }, { content: 'finalized' }, { content: 'follow-up answer' },
    ], onProvider(call, queue) {
      if (call === 3) {
        expect(queue.closed).toBe(false)
        queue.enqueue({ requestId: 'q', content: 'follow up during finalization' }, 0)
      }
    } })
    await h.run()
    expect(h.requests).toHaveLength(4)
    expect(h.requests[3].history.at(-1).id).toBe('q')
    expect(h.persisted.at(-1).content).toBe('follow-up answer')
  })

  it('inserts after tools and compaction, not into a partial tool batch', async () => {
    const h = loopHarness({ compact: true, outputs: [
      { content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }] }, { content: 'answer' },
    ], onTool(queue) { queue.enqueue({ requestId: 'q1', content: 'new instruction' }, 0) } })
    await h.run()
    expect(h.requests[1].history.map((row: any) => row.id)).toEqual(['summary', 'q1'])
    expect(h.persisted.find(row => row.id === 'q1').parent_id).toBe('summary')
  })

  it('keeps image payload on its own queued user row, not a later notification/user message', async () => {
    const h = loopHarness({ outputs: [{ content: 'first answer' }, { content: 'image answer' }], onProvider(call, queue) {
      if (call === 1) {
        queue.enqueue({ requestId: 'image', content: 'look', attachmentsBase64: [{ dataUrl: 'data:image/png;base64,AAA' }] }, 0)
        queue.enqueue({ requestId: 'text', content: 'then explain' }, 0)
      }
    } })
    await h.run()
    const messages = toCodexMessages(h.requests[1])
    const image = messages.find(message => message.role === 'user' && message.content === 'look')
    expect(image?.contentParts).toContainEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAA' })
    expect(messages.find(message => message.content === 'then explain')?.contentParts).not.toContainEqual(expect.objectContaining({ type: 'input_image' }))
  })
})

describe('queue intake completion race', () => {
  it('validates ownership, joins live runs, and deduplicates successor creation', async () => {
    const { ChatOrchestrator } = await import('../chatOrchestrator.js')
    const orchestrator = Object.create(ChatOrchestrator.prototype) as any
    const queue = makeQueue()
    const run = { queue, request: { conversationId: 'c', provider: 'openaichatgpt', operation: 'send', content: 'original' },
      control: new OperationModeControl('plan'), head: 'final', terminal: undefined as string | undefined }
    orchestrator.inputRuns = new Map([['s', run]])
    orchestrator.lineageRepo = { get: () => ({ id: 'l', head_message_id: 'final' }) }
    const submission = { requestId: 'q', content: 'follow up' }
    expect(() => orchestrator.submitQueuedMessage('other', 's', submission)).toThrow('conversation')
    expect(orchestrator.submitQueuedMessage('c', 's', submission).snapshot.items).toHaveLength(1)
    queue.claim(); queue.settle('q', { messageId: 'delivered' }); queue.tryClose()
    run.terminal = 'completed'
    expect(orchestrator.submitQueuedMessage('c', 's', submission).snapshot.items[0].messageId).toBe('delivered')
    const next = { requestId: 'next', content: 'after completion' }
    const result = orchestrator.submitQueuedMessage('c', 's', next)
    expect(result.restart).toMatchObject({ operation: 'send', parentId: 'final', lineageId: 'l', content: 'after completion', operationMode: 'plan' })
    expect(orchestrator.submitQueuedMessage('c', 's', next)).toEqual({ restartStreamId: result.restart.streamId })
  })
})
