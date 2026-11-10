import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ cells: [] as any[], cursor: 0, effects: [] as Array<() => void> }))
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.cells)) hooks.cells[index] = initial
    return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = value }]
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    return hooks.cells[index] ?? (hooks.cells[index] = { current: initial })
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void, dependencies: unknown[]) => {
    const index = hooks.cursor++
    const previous = hooks.cells[index]
    if (!previous || dependencies.some((value, i) => value !== previous[i])) hooks.effects.push(effect)
    hooks.cells[index] = dependencies
  },
}))
import { isPromptCacheAtStake, MODEL_SWITCH_CACHE_TTL_MS, needsModelSwitchConfirmation, useModelSwitchConfirmation } from './useModelSwitchConfirmation'
import type { BranchModelSelection } from '../features/chats/branchModelSelection'
const original = { provider: 'OpenRouter', model: 'model-a' }
const next = { provider: 'OpenRouter', model: 'model-b' }
function render(scope = 'branch-a', current: BranchModelSelection | null = original) {
  hooks.cursor = 0
  const result = useModelSwitchConfirmation(scope, current)
  hooks.effects.splice(0).forEach(effect => effect())
  return result
}
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = [] })

describe('model switch confirmation', () => {
  it('only warns for changes to a known branch selection', () => {
    expect(needsModelSwitchConfirmation(null, next)).toBe(false)
    expect(needsModelSwitchConfirmation(original, original)).toBe(false)
    expect(needsModelSwitchConfirmation(original, { ...original, model: null })).toBe(false)
    expect(needsModelSwitchConfirmation(original, next)).toBe(true)
    expect(needsModelSwitchConfirmation(original, { provider: 'LM Studio', model: null })).toBe(true)
  })
  it('does not mutate selection until confirmed', () => {
    const apply = vi.fn()
    render().request(next, apply)
    expect(apply).not.toHaveBeenCalled()
    const dialog = render()
    expect(dialog.pending?.to).toEqual(next)
    dialog.confirm()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(render().pending).toBeNull()
  })
  it('cancel keeps the old selection untouched', () => {
    const apply = vi.fn()
    render().request(next, apply)
    render().cancel()
    expect(render().pending).toBeNull()
    expect(apply).not.toHaveBeenCalled()
  })
  it('discards a pending switch when navigating to another branch', () => {
    const apply = vi.fn()
    render().request(next, apply)
    const stale = render()
    expect(render('branch-b').pending).toBeNull()
    stale.confirm()
    expect(apply).not.toHaveBeenCalled()
    expect(render().pending).toBeNull()
  })
  it('rejects an asynchronous auth completion from another branch', () => {
    const apply = vi.fn()
    const origin = render()
    render('branch-b')
    origin.request(next, apply)
    expect(apply).not.toHaveBeenCalled()
    expect(render('branch-b').pending).toBeNull()
  })
  it('does not apply a confirmation after its original selection changed', () => {
    const apply = vi.fn()
    render().request(next, apply)
    render('branch-a', { provider: 'LM Studio', model: 'local' }).confirm()
    expect(apply).not.toHaveBeenCalled()
  })
  it('skips the dialog when the branch has no cacheable history', () => {
    const apply = vi.fn()
    hooks.cursor = 0
    useModelSwitchConfirmation('branch-a', original, null).request(next, apply)
    expect(apply).toHaveBeenCalledOnce()
    expect(render().pending).toBeNull()
  })
  it('skips the dialog once the last message is older than the cache TTL', () => {
    const now = Date.parse('2026-10-29T12:00:00Z')
    expect(isPromptCacheAtStake('2026-10-29T11:55:00Z', now)).toBe(true)
    expect(isPromptCacheAtStake('2026-10-29T11:49:00Z', now)).toBe(false)
    // SQLite CURRENT_TIMESTAMP has no zone marker and is UTC.
    expect(isPromptCacheAtStake('2026-10-29 11:55:00', now)).toBe(true)
    expect(isPromptCacheAtStake('2026-10-29 11:49:00', now)).toBe(false)
    expect(isPromptCacheAtStake(null, now)).toBe(false)
    expect(isPromptCacheAtStake('not a date', now)).toBe(true)
    const apply = vi.fn()
    hooks.cursor = 0
    useModelSwitchConfirmation('branch-a', original, new Date(Date.now() - MODEL_SWITCH_CACHE_TTL_MS - 1000).toISOString()).request(next, apply)
    expect(apply).toHaveBeenCalledOnce()
  })
  it('allows initial selection without a dialog', () => {
    const apply = vi.fn()
    render('new', null).request(next, apply)
    expect(apply).toHaveBeenCalledOnce()
    expect(render('new', null).pending).toBeNull()
  })
})
