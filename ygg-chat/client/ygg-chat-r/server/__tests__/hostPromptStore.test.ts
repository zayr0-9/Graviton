import { describe, expect, it } from 'vitest'
import { HostPromptStore } from '../hostPromptStore.js'
import { validateHostPrompts } from '../../../../shared/hostPrompts.js'
const prompt = (id: string, is_default = false) => ({ id: `local-${id}`, owner_id: 'local', name: id, content: 'Instructions', description: null,
  is_default, created_at: '2026-01-01', updated_at: '2026-01-01', storage_mode: 'local' as const })
function setup() {
  const data = new Map<string, unknown>()
  const backing = { get: (key: string) => data.get(key), set: (key: string, value: unknown) => { data.set(key, structuredClone(value)) }, delete: (key: string) => { data.delete(key) } }
  return { a: new HostPromptStore(backing), b: new HostPromptStore(backing) }
}
describe('host-owned prompts', () => {
  it('rejects stale concurrent saves without losing acknowledged data', () => {
    const { a, b } = setup()
    const old = b.snapshot()
    a.save(0, [prompt('first')], a.snapshot())
    expect(() => b.save(old.revision, [prompt('second')], old)).toThrow('another client')
    expect(b.snapshot().prompts.map(row => row.id)).toEqual(['local-first'])
  })
  it('imports once without replacing existing IDs or defaults', () => {
    const { a, b } = setup()
    a.save(0, [prompt('host', true)], a.snapshot())
    a.importLegacy([{ ...prompt('host'), content: 'Old content' }, prompt('desktop', true)])
    expect(b.snapshot().prompts).toEqual([prompt('host', true), prompt('desktop', false)])
    const revision = b.snapshot().revision
    b.importLegacy([prompt('later')])
    expect(a.snapshot().revision).toBe(revision)
    expect(a.snapshot().prompts).toHaveLength(2)
  })
  it('bounds schema and strips unknown fields', () => {
    expect(validateHostPrompts([{ ...prompt('a'), unrelated: 'not public' }])[0]).not.toHaveProperty('unrelated')
    expect(() => validateHostPrompts([prompt('a'), prompt('a')])).toThrow('duplicate')
    expect(() => validateHostPrompts([prompt('a', true), prompt('b', true)])).toThrow('one default')
    expect(() => validateHostPrompts([{ ...prompt('a'), content: 'x'.repeat(200001) }])).toThrow('content')
  })
})

it('retains corrupt import data for repair without blocking startup', () => {
  const { a } = setup()
  expect(a.importLegacy('{broken').prompts).toEqual([])
  expect(a.importLegacy([prompt('repaired')]).prompts).toEqual([prompt('repaired')])
  expect(a.importLegacy('{obsolete broken').prompts).toEqual([prompt('repaired')])
})
it('fences foreign host and old epoch writes and deduplicates an acknowledged replacement', () => {
  const { a } = setup()
  const identity = a.snapshot()
  a.save(0, [prompt('saved')], identity)
  expect(a.save(0, [prompt('saved')], identity).revision).toBe(1)
  expect(() => a.save(1, [], { ...identity, epoch: 'old' })).toThrow('host changed')
  expect(() => a.save(1, [], { ...identity, hostId: 'other' })).toThrow('host changed')
})
