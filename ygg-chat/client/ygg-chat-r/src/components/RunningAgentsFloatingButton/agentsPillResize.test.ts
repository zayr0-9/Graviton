import { describe, expect, it } from 'vitest'
import { clampAgentsPillSize, resizeAgentsPillFromCorner } from './agentsPillResize'
import reducer, { runningAgentsUiActions as actions } from '../../features/ui/runningAgentsUiSlice'

const space = { right: 1200, bottom: 800 }
describe('agents pill resize geometry', () => {
  it('grows left/up and shrinks right/down while preserving the bottom-right anchor', () => {
    expect(resizeAgentsPillFromCorner({ width: 400, height: 400 }, -100, -50, space)).toEqual({ width: 500, height: 450 })
    expect(resizeAgentsPillFromCorner({ width: 400, height: 400 }, 30, 40, space)).toEqual({ width: 370, height: 360 })
  })
  it('clamps to minimum dimensions and actual available anchor space', () => {
    expect(clampAgentsPillSize({ width: 1, height: 1 }, space)).toEqual({ width: 320, height: 240 })
    expect(clampAgentsPillSize({ width: 2000, height: 2000 }, space)).toEqual({ width: 1188, height: 788 })
  })
  it('lowers minimums on tiny viewports', () => {
    expect(clampAgentsPillSize({ width: 400, height: 400 }, { right: 200, bottom: 150 })).toEqual({ width: 188, height: 138 })
  })
  it('does not destroy preferred dimensions while the viewport is temporarily smaller', () => {
    const preferred = { width: 650, height: 700 }
    expect(clampAgentsPillSize(preferred, { right: 500, bottom: 600 })).toEqual({ width: 488, height: 588 })
    expect(clampAgentsPillSize(preferred, space)).toEqual(preferred)
    expect(preferred).toEqual({ width: 650, height: 700 })
  })
})

describe('session-only agents pill dimensions', () => {
  it('starts automatic, retains size across unrelated navigation/pruning, and resets explicitly', () => {
    let state = reducer(undefined, { type: 'init' })
    expect(state.expandedSize).toBeNull()
    state = reducer(state, actions.sizeChanged({ width: 600, height: 500 }))
    state = reducer(state, { type: 'chat/conversationSet', payload: 'other' })
    state = reducer(state, { type: 'chat/streamPruned', payload: { streamId: 'run' } })
    expect(state.expandedSize).toEqual({ width: 600, height: 500 })
    expect(reducer(state, actions.sizeReset()).expandedSize).toBeNull()
    expect(reducer(state, { type: 'users/clearUser' }).expandedSize).toBeNull()
    expect(reducer(undefined, { type: 'init' }).expandedSize).toBeNull()
  })
  it('rejects invalid geometry', () => {
    const state = reducer(undefined, actions.sizeChanged({ width: 600, height: 500 }))
    for (const size of [{ width: NaN, height: 3 }, { width: 4, height: Infinity }, { width: -1, height: 5 }]) {
      expect(reducer(state, actions.sizeChanged(size))).toBe(state)
    }
  })
})
