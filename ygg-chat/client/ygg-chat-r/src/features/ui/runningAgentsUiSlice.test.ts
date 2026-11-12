import { describe, expect, it } from 'vitest'
import reducer, { isAgentForkHidden, MAX_HIDDEN_AGENT_FORKS, runningAgentsUiActions as actions } from './runningAgentsUiSlice'

describe('runningAgentsUi hidden forks', () => {
  it('hides a fork until it gains an unseen run, and restores it', () => {
    let state = reducer(undefined, actions.forkHidden({ key: 'f', streamIds: ['a', 'b'] }))
    expect(isAgentForkHidden(state.hiddenForks, 'f', ['a', 'b'])).toBe(true)
    expect(isAgentForkHidden(state.hiddenForks, 'f', ['b'])).toBe(true)
    expect(isAgentForkHidden(state.hiddenForks, 'f', ['c', 'a', 'b'])).toBe(false)
    expect(isAgentForkHidden(state.hiddenForks, 'other', ['a'])).toBe(false)
    state = reducer(state, actions.forkShown('f'))
    expect(state.hiddenForks).toEqual({})
  })

  it('keeps hidden forks across size resets but clears them on sign-out', () => {
    let state = reducer(undefined, actions.forkHidden({ key: 'f', streamIds: ['a'] }))
    state = reducer(reducer(state, actions.sizeChanged({ width: 400, height: 300 })), actions.sizeReset())
    expect(state).toEqual({ expandedSize: null, hiddenForks: { f: ['a'] }, collapsedForks: [] })
    expect(reducer(state, { type: 'users/clearUser' }).hiddenForks).toEqual({})
    expect(reducer(state, actions.allForksShown()).hiddenForks).toEqual({})
  })

  it('bounds the session list, dropping the oldest hides first', () => {
    let state = reducer(undefined, { type: 'init' })
    for (let index = 0; index <= MAX_HIDDEN_AGENT_FORKS; index++) state = reducer(state, actions.forkHidden({ key: `f${index}`, streamIds: [] }))
    expect(Object.keys(state.hiddenForks)).toHaveLength(MAX_HIDDEN_AGENT_FORKS)
    expect(state.hiddenForks.f0).toBeUndefined()
  })

  it('collapses and expands cards independently of hiding', () => {
    let state = reducer(undefined, actions.forkCollapsed('a'))
    state = reducer(reducer(state, actions.forkCollapsed('b')), actions.forkCollapsed('a'))
    expect(state.collapsedForks).toEqual(['b', 'a'])
    state = reducer(state, actions.forkHidden({ key: 'a', streamIds: [] }))
    expect(reducer(state, actions.forkExpanded('a')).collapsedForks).toEqual(['b'])
    expect(reducer(state, { type: 'users/clearUser' }).collapsedForks).toEqual([])
    for (let index = 0; index <= MAX_HIDDEN_AGENT_FORKS; index++) state = reducer(state, actions.forkCollapsed(`f${index}`))
    expect(state.collapsedForks).toHaveLength(MAX_HIDDEN_AGENT_FORKS)
    expect(state.collapsedForks).not.toContain('b')
  })
})
