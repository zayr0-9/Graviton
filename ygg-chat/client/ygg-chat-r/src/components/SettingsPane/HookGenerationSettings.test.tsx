import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { DEFAULT_HOST_HOOK_GENERATION } from '../../../../../shared/hostHookGeneration'

// Minimal hook driver: exercise actual JSX handlers without adding a DOM dependency.
const hooks = vi.hoisted(() => ({ values: [] as any[], cursor: 0, cleanups: [] as Array<() => void> }))
const host = vi.hoisted(() => ({ value: {} as any, revision: 3, save: vi.fn(), refresh: vi.fn() }))
vi.mock('react', async () => ({ ...(await vi.importActual<any>('react')),
  useState: (initial: any) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[index], (next: any) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next }]
  },
  useRef: (value: any) => {
    const index = hooks.cursor++
    hooks.values[index] ??= { current: value }
    return hooks.values[index]
  },
  useEffect: (effect: () => (() => void)) => {
    const index = hooks.cursor++
    if (!(index in hooks.values)) { hooks.values[index] = true; hooks.cleanups.push(effect()) }
  },
}))
vi.mock('../../services/hostExecutionClient', () => ({
  getHostExecutionPreferences: () => ({ hookGeneration: host.value }), getHostExecutionRevision: () => host.revision,
  HOST_EXECUTION_CHANGED: 'execution-changed', refreshHostExecutionPreferences: () => host.refresh(),
  saveHostExecutionPreference: (...args: any[]) => host.save(...args),
}))
vi.mock('../../utils/api', () => ({ localApi: { get: async () => ({ provider: 'claudecode', claudeInstalled: true, modelName: '', openAiStatus: 'signed_out' }) } }))
import { HookGenerationSettings } from './HookGenerationSettings'
const render = () => { hooks.cursor = 0; return HookGenerationSettings() }
const elements = (node: any): ReactElement<any>[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...elements(node.props.children)]
}
const field = (label: string) => elements(render()).find(el => el.props['aria-label'] === label)!
const button = (text: string) => elements(render()).find(el => el.type === 'button' && el.props.children === text)!
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.cleanups = []
  host.value = { ...DEFAULT_HOST_HOOK_GENERATION }; host.revision = 3
  host.save.mockReset().mockResolvedValue(undefined); host.refresh.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => { hooks.cleanups.forEach(cleanup => cleanup?.()); vi.unstubAllGlobals() })
it('offers Auto/OpenAI/Claude, retains separate models and saves the captured edit base', async () => {
  render(); await flush()
  expect(elements(field('Hook generation provider')).filter(el => el.type === 'option').map(el => el.props.value)).toEqual(['auto', 'openaichatgpt', 'claudecode'])
  field('Claude hook model').props.onChange({ target: { value: 'sonnet' } })
  field('Hook generation provider').props.onChange({ target: { value: 'openaichatgpt' } })
  field('OpenAI hook model').props.onChange({ target: { value: 'gpt-custom' } })
  host.revision = 8
  window.dispatchEvent(new Event('execution-changed'))
  field('Hook generation provider').props.onChange({ target: { value: 'claudecode' } })
  expect(field('Claude hook model').props.value).toBe('sonnet')
  await button('Save hook provider').props.onClick()
  expect(host.save).toHaveBeenCalledWith({ hookGeneration: { provider: 'claudecode', openAiModel: 'gpt-custom', claudeModel: 'sonnet' } }, 3)
})
it('keeps edits after rejected saves and reloads only when requested', async () => {
  render(); await flush()
  field('Claude hook model').props.onChange({ target: { value: 'opus' } })
  host.save.mockRejectedValueOnce(new Error('Host settings changed'))
  await button('Save hook provider').props.onClick()
  expect(field('Claude hook model').props.value).toBe('opus')
  host.value = { ...host.value, claudeModel: 'haiku' }; host.revision = 9
  window.dispatchEvent(new Event('execution-changed'))
  expect(field('Claude hook model').props.value).toBe('opus')
  await button('Reload hook settings').props.onClick()
  expect(field('Claude hook model').props.value).toBe('haiku')
  await button('Save hook provider').props.onClick()
  expect(host.save.mock.calls.at(-1)?.[1]).toBe(9)
})
it('refreshes a clean form from the shared host event', async () => {
  render(); await flush()
  host.value = { ...host.value, provider: 'claudecode', claudeModel: 'haiku' }; host.revision = 4
  window.dispatchEvent(new Event('execution-changed'))
  expect(field('Hook generation provider').props.value).toBe('claudecode')
  expect(field('Claude hook model').props.value).toBe('haiku')
})
