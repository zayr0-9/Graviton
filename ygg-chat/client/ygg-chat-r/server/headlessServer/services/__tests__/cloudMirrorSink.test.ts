import { describe, expect, it, vi } from 'vitest'
import type { MessageRepo } from '../../persistence/messageRepo.js'
import { CloudMirrorSink, TreeMessageSink } from '../messageSink.js'

/**
 * Phase 4 — CloudMirrorSink adopts the Railway id; TreeMessageSink must NOT (byte-for-byte
 * main-tree parity). DB-free: a fake MessageRepo records the createMessage input.
 */
function makeFakeRepo() {
  const createMessage = vi.fn((input: any) => ({ ...input, id: input.id ?? 'minted-uuid' }))
  const updateAssistantToolState = vi.fn((messageId: string, update: any) => ({ messageId, ...update }))
  return { createMessage, updateAssistantToolState } as unknown as MessageRepo & {
    createMessage: ReturnType<typeof vi.fn>
    updateAssistantToolState: ReturnType<typeof vi.fn>
  }
}

const draft = { conversationId: 'c1', parentId: 'p1', content: 'answer', modelName: 'm' }

describe('CloudMirrorSink', () => {
  it('forwards the Railway providerMessageId as the createMessage id', () => {
    const repo = makeFakeRepo()
    new CloudMirrorSink({ messageRepo: repo }).persistAssistantMessage({ ...draft, providerMessageId: 'railway-1' })
    expect(repo.createMessage.mock.calls[0][0].id).toBe('railway-1')
  })

  it('passes id undefined when there is no providerMessageId (falls back to mint)', () => {
    const repo = makeFakeRepo()
    new CloudMirrorSink({ messageRepo: repo }).persistAssistantMessage({ ...draft })
    expect(repo.createMessage.mock.calls[0][0].id).toBeUndefined()
  })

  it('forwards updateAssistantToolState verbatim', () => {
    const repo = makeFakeRepo()
    new CloudMirrorSink({ messageRepo: repo }).updateAssistantToolState('m1', { contentBlocks: [], toolCalls: [] })
    expect(repo.updateAssistantToolState).toHaveBeenCalledWith('m1', { contentBlocks: [], toolCalls: [] })
  })

  it('regression: TreeMessageSink NEVER forwards an id even when providerMessageId is present', () => {
    const repo = makeFakeRepo()
    new TreeMessageSink({ messageRepo: repo }).persistAssistantMessage({ ...draft, providerMessageId: 'railway-1' } as any)
    expect(repo.createMessage.mock.calls[0][0].id).toBeUndefined()
  })
})

describe('run attribution', () => {
  it.each([TreeMessageSink, CloudMirrorSink])('stamps responses and distinguishes terminal error rows through %s', Sink => {
    const repo = makeFakeRepo()
    const sink = new Sink({ messageRepo: repo, streamId: 'run-1' })
    sink.persistAssistantMessage(draft)
    sink.persistAssistantMessage({ ...draft, statisticsKind: 'terminal_error' })
    expect(repo.createMessage.mock.calls[0][0].meta).toEqual({
      runStatistics: { version: 1, streamId: 'run-1', kind: 'model_response' },
    })
    expect(repo.createMessage.mock.calls[1][0].meta.runStatistics.kind).toBe('terminal_error')
  })
})

describe('branch model attribution', () => {
  it.each([TreeMessageSink, CloudMirrorSink])('persists provider/model metadata without changing inference text through %s', Sink => {
    const repo = makeFakeRepo()
    const modelSelection = { provider: 'openaichatgpt', model: 'gpt-test' }
    new Sink({ messageRepo: repo, streamId: 'run', modelSelection }).persistAssistantMessage({ ...draft, meta: { existing: true } })
    const saved = repo.createMessage.mock.calls[0][0]
    expect(saved.content).toBe(draft.content)
    expect(saved.meta).toMatchObject({ existing: true, modelSelection, runStatistics: { streamId: 'run' } })
  })
})
