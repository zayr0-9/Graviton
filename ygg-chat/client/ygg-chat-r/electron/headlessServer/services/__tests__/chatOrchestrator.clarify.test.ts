/**
 * Reproduction for the plan_md clarify pause/resume hang, DB-free.
 *
 * Exercises the exact server seam: createChatPausingExecutor intercepts a
 * plan_md {action:'clarify'} call, emits `clarify_required`, and awaits the
 * DecisionBroker. We then resolve the broker the way POST /api/resume does and
 * assert the executor RESUMES with the clarify result instead of hanging.
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatPausingExecutor } from '../chatOrchestrator.js'
import { DecisionBroker } from '../decisionBroker.js'

const clarifyCall = {
  id: 'call-clarify',
  name: 'plan_md',
  arguments: JSON.stringify({ action: 'clarify', questions: [{ question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] }] }),
}
const ctx = { conversationId: 'c1', messageId: 'm1', streamId: 's1' } as any

describe('createChatPausingExecutor — plan_md clarify pause/resume', () => {
  it('emits clarify_required with the tool call id and pauses on the broker', async () => {
    const broker = new DecisionBroker()
    const emitted: any[] = []
    const base = vi.fn(async () => 'BASE_SHOULD_NOT_RUN')
    const exec = createChatPausingExecutor({ base, broker, streamId: 's1', emit: e => emitted.push(e) })

    const resultPromise = exec(clarifyCall as any, ctx)
    // Let the microtask that emits + registers the pending decision run.
    await Promise.resolve()

    const clarify = emitted.find(e => e.type === 'clarify_required')
    expect(clarify).toMatchObject({ type: 'clarify_required', streamId: 's1', toolCallId: 'call-clarify', toolName: 'plan_md' })
    // The pending entry MUST be registered under the SAME (streamId, toolCallId)
    // the event carries — this is what POST /api/resume correlates on.
    expect(broker.hasPending('s1', 'call-clarify')).toBe(true)
    expect(base).not.toHaveBeenCalled() // clarify never hits the base executor

    // Resume exactly like the /api/resume clarify branch does.
    const matched = broker.resolve('s1', 'call-clarify', {
      answers: [{ questionId: 'which-approach', question: 'Which approach?', selectedOptionLabel: 'A', manual: false, answer: 'A' }],
    })
    expect(matched).toBe(true)

    const result = await resultPromise
    expect(result).toMatchObject({ clarified: true, cancelled: false })
    expect(result.answers?.[0]?.answer).toBe('A')
  })

  it('a cancel decision resolves the executor with cancelled=true', async () => {
    const broker = new DecisionBroker()
    const emitted: any[] = []
    const exec = createChatPausingExecutor({ base: vi.fn(), broker, streamId: 's1', emit: e => emitted.push(e) })

    const resultPromise = exec(clarifyCall as any, ctx)
    await Promise.resolve()
    expect(broker.resolve('s1', 'call-clarify', { cancelled: true })).toBe(true)

    const result = await resultPromise
    expect(result).toMatchObject({ clarified: false, cancelled: true })
  })
})
