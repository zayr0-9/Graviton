import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptWatchContinuation } from './watchContinuation'
import { addInflightStream, listInflightStreams } from './inflightStreams'
import type { WatchCompletionEvent } from '../../../../../shared/watchEvents'

beforeEach(() => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value) })
})
afterEach(() => vi.unstubAllGlobals())
const event: WatchCompletionEvent = { handle: 'watch', state: 'triggered', kind: 'process_exit',
  conversationId: 'chat', lineageId: 'branch', messageId: 'origin', projectId: null, completedAt: 'now',
  delivery: 'restarted', streamId: 'successor', parentId: 'current-tail' }

describe('watcher continuation adoption', () => {
  it('adopts a new successor as background without advancing selected path', () => {
    expect(adoptWatchContinuation(event, () => false)).toBe('successor')
    expect(listInflightStreams()).toEqual([{ streamId: 'successor', conversationId: 'chat', streamType: 'branch',
      parentMessageId: 'current-tail', updatePath: false }])
  })
  it('preserves an existing primary cursor/path policy and skips an owned reader', () => {
    const primary = { streamId: 'successor', conversationId: 'chat', streamType: 'primary' as const, parentMessageId: 'parent', lastSeq: 42, updatePath: true }
    addInflightStream(primary)
    expect(adoptWatchContinuation(event, () => false)).toBe('successor')
    expect(listInflightStreams()).toEqual([primary])
    expect(adoptWatchContinuation(event, () => true)).toBeNull()
    expect(listInflightStreams()).toEqual([primary])
  })
  it('attaches accepted queued outcomes but not failed or legacy events', () => {
    expect(adoptWatchContinuation({ ...event, delivery: 'failed' }, () => false)).toBeNull()
    expect(adoptWatchContinuation({ ...event, delivery: undefined }, () => false)).toBeNull()
    expect(listInflightStreams()).toEqual([])
    expect(adoptWatchContinuation({ ...event, state: 'timed_out', delivery: 'queued' }, () => false)).toBe('successor')
  })
  it('background reattachment preserves image drafts, composer and primary selection', async () => {
    const { default: chatReducer, chatSliceActions } = await import('./chatSlice')
    const state = structuredClone(chatReducer(undefined, { type: 'init' }))
    state.composition.input.content = 'unsent text'
    state.composition.imageDrafts = [{ name: 'draft', dataUrl: 'data:image/png;base64,AAA' } as any]
    state.composition.imageDraftTarget = { kind: 'branch' } as any
    state.conversation.currentPath = ['selected']
    const result = chatReducer(state, chatSliceActions.sendingStarted({ streamId: 'successor', conversationId: 'chat',
      streamType: 'branch', preserveDrafts: true }))
    expect(result.composition.imageDrafts).toEqual(state.composition.imageDrafts)
    expect(result.composition.input.content).toBe('unsent text')
    expect(result.conversation.currentPath).toEqual(['selected'])
    expect(result.streaming.primaryStreamId).toBe(state.streaming.primaryStreamId)
    const { applyStreamProjectionPolicy } = await import('./sseProjection')
    const selected = structuredClone(result)
    selected.conversation.currentConversationId = 'chat'
    const modeAction = applyStreamProjectionPolicy(chatSliceActions.operationModeNotificationReceived({
      message: { id: 'mode', conversation_id: 'chat', parent_id: 'selected' } as any, mode: 'execute', streamId: 'successor',
    }), { streamId: 'successor', streamType: 'branch', updatePath: false })
    const afterMode = chatReducer(selected, modeAction)
    expect(afterMode.conversation.currentPath).toEqual(['selected'])
    expect(afterMode.operationMode).toBe(selected.operationMode)
  })
})
