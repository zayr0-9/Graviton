import './__testSupport__/localStorageShim'
import { describe, expect, it } from 'vitest'
import reducer, { chatSliceActions } from './chatSlice'

describe('branch-scoped tool decision state', () => {
  it('keeps simultaneous permission requests isolated by stream', () => {
    let state = reducer(undefined, { type: '@@init' })
    state = reducer(
      state,
      chatSliceActions.toolPermissionRequested({
        toolCall: { id: 'tc-a', name: 'bash', arguments: {} } as any,
        streamId: 'stream-a',
        toolCallId: 'tc-a',
      })
    )
    state = reducer(
      state,
      chatSliceActions.toolPermissionRequested({
        toolCall: { id: 'tc-b', name: 'edit_file', arguments: {} } as any,
        streamId: 'stream-b',
        toolCallId: 'tc-b',
      })
    )

    expect(state.toolPermissionRequestsByStream['stream-a'].toolCallId).toBe('tc-a')
    expect(state.toolPermissionRequestsByStream['stream-b'].toolCallId).toBe('tc-b')

    state = reducer(state, chatSliceActions.toolPermissionRespondedForStream('stream-b'))
    expect(state.toolPermissionRequestsByStream['stream-a'].toolCallId).toBe('tc-a')
    expect(state.toolPermissionRequestsByStream['stream-b']).toBeUndefined()
  })

  it('clears only the terminal stream across all decision kinds', () => {
    let state = reducer(undefined, { type: '@@init' })
    state = reducer(
      state,
      chatSliceActions.operationModeUpgradeRequested({
        toolCall: { id: 'upgrade-a', name: 'edit_file', arguments: {} } as any,
        streamId: 'stream-a',
        toolCallId: 'upgrade-a',
      })
    )
    state = reducer(
      state,
      chatSliceActions.planClarificationRequested({
        id: 'clarify-b',
        questions: [{ id: 'q1', question: 'Continue?' }],
        streamId: 'stream-b',
        toolCallId: 'clarify-b',
      })
    )

    state = reducer(state, chatSliceActions.decisionRequestsClearedForStream('stream-a'))
    expect(state.operationModeUpgradeRequestsByStream['stream-a']).toBeUndefined()
    expect(state.planClarificationRequestsByStream['stream-b']?.toolCallId).toBe('clarify-b')
  })
})
