import { describe, expect, it } from 'vitest'
import type { MessageSink } from '../messageSink.js'
import type { ProviderRouter } from '../providerRouter.js'
import { ToolLoopService, type ToolLoopHooks } from '../toolLoopService.js'
import { buildSystemPromptWithHookContext } from '../chatHookService.js'

// A minimal in-memory MessageSink so these tests need no native better-sqlite3 —
// the loop only requires a row-shaped object with id/role/content/content_blocks/tool_calls.
function makeFakeSink(): MessageSink {
  let counter = 0
  const rows = new Map<string, any>()
  return {
    persistAssistantMessage(draft) {
      const id = `a${++counter}`
      const row = {
        id,
        conversation_id: draft.conversationId,
        parent_id: draft.parentId,
        role: 'assistant',
        content: draft.content ?? '',
        content_blocks: JSON.stringify(draft.contentBlocks ?? []),
        tool_calls: JSON.stringify(draft.toolCalls ?? []),
      }
      rows.set(id, row)
      return row
    },
    updateAssistantToolState(messageId, update) {
      const row = rows.get(messageId)
      if (!row) return null
      const updated = {
        ...row,
        content_blocks: JSON.stringify(update.contentBlocks ?? []),
        tool_calls: JSON.stringify(update.toolCalls ?? []),
      }
      rows.set(messageId, updated)
      return updated
    },
  }
}

class FakeProviderRouter {
  private readonly queued: any[] = []
  readonly calls: Array<{ provider: string; input: any }> = []
  enqueue(output: any): void {
    this.queued.push(output)
  }
  async generate(provider: string, input: any): Promise<any> {
    this.calls.push({ provider, input })
    return this.queued.length > 0 ? this.queued.shift() : { content: 'default' }
  }
}

/** A faithful stand-in for the ChatHookSession adapter: shared buffer + real fold + Stop. */
function makeHooks(stopDecisions: boolean[]): ToolLoopHooks {
  const hookContext: string[] = []
  let stopIndex = 0
  return {
    hookContext,
    foldSystemPrompt(base) {
      if (hookContext.length === 0) return base ?? null
      return buildSystemPromptWithHookContext(base, hookContext)
    },
    async runStop() {
      const decision = stopDecisions[stopIndex++] ?? false
      if (decision) {
        hookContext.push('continue-ctx')
        return true
      }
      return false
    },
  }
}

function makeLoop(providerRouter: FakeProviderRouter): ToolLoopService {
  return new ToolLoopService({ sink: makeFakeSink(), providerRouter: providerRouter as unknown as ProviderRouter })
}

const baseInput = {
  provider: 'lmstudio',
  modelName: 'qwen',
  conversationId: 'c1',
  assistantParentId: null,
  history: [] as any[],
  userContent: 'go',
  systemPrompt: 'BASE',
}

describe('ToolLoopService hooks', () => {
  it('Stop hook force-continues one more turn, folding its context into the next system prompt', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'answer 1' }) // turn 1: no tool calls -> Stop hook fires
    providerRouter.enqueue({ content: 'answer 2' }) // turn 2 (forced): Stop returns false -> stop

    const hooks = makeHooks([true, false])
    const result = await makeLoop(providerRouter).run({ ...baseInput, hooks }, () => {})

    expect(result.turnsUsed).toBe(2)
    // Turn 1 saw the unmodified base (buffer empty at the start of turn 1).
    expect(providerRouter.calls[0].input.systemPrompt).toBe('BASE')
    // Turn 2 saw the Stop hook's context folded in.
    expect(providerRouter.calls[1].input.systemPrompt).toContain('[Hook context]\ncontinue-ctx')
    // Buffer is cleared after folding (no leak into a would-be turn 3).
    expect(hooks.hookContext).toEqual([])
  })

  it('Stop hook returning false stops after one turn (no forced continuation)', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'done' })
    const hooks = makeHooks([false])

    const result = await makeLoop(providerRouter).run({ ...baseInput, hooks }, () => {})
    expect(result.turnsUsed).toBe(1)
    expect(providerRouter.calls).toHaveLength(1)
    expect(providerRouter.calls[0].input.systemPrompt).toBe('BASE')
  })

  it('regression: without hooks the loop stops after one turn and never touches the system prompt', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'answer' })

    const result = await makeLoop(providerRouter).run({ ...baseInput }, () => {})
    expect(result.turnsUsed).toBe(1)
    expect(providerRouter.calls).toHaveLength(1)
    expect(providerRouter.calls[0].input.systemPrompt).toBe('BASE')
  })

  it('a Stop hook that forces continuation past the turn cap finalizes gracefully (no throw)', async () => {
    const providerRouter = new FakeProviderRouter()
    for (let i = 0; i < 5; i++) providerRouter.enqueue({ content: `turn ${i + 1}` })
    const hooks = makeHooks([true, true, true, true, true]) // always force-continue

    // maxTurns clamped to 3; with an unconditional Stop-continue this would hit the cap
    // and previously THREW. It must now return the last valid natural-stop answer.
    const result = await makeLoop(providerRouter).run({ ...baseInput, maxTurns: 3, hooks }, () => {})
    expect(result.turnsUsed).toBe(3)
    expect(result.finalAssistantMessage.content).toBe('turn 3')
  })

  it('pre-seeded hook context folds into turn 1 (UserPromptSubmit path), then clears', async () => {
    const providerRouter = new FakeProviderRouter()
    providerRouter.enqueue({ content: 'answer' })
    const hooks = makeHooks([false])
    hooks.hookContext.push('seeded-by-userpromptsubmit')

    await makeLoop(providerRouter).run({ ...baseInput, hooks }, () => {})
    expect(providerRouter.calls[0].input.systemPrompt).toContain('[Hook context]\nseeded-by-userpromptsubmit')
    expect(hooks.hookContext).toEqual([])
  })
})
