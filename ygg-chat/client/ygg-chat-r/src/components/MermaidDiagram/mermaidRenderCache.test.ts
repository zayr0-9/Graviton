import { describe, expect, it, vi } from 'vitest'
import { getMermaidRenderKey, loadMermaidRender, MermaidRenderCache, mermaidRenderCache } from './mermaidRenderCache'

const result = (svg = '<svg/>') => ({ svg, size: { width: 400, height: 300 } })

describe('Mermaid render cache', () => {
  it('keys by source, theme, and configuration version', () => {
    const key = getMermaidRenderKey('graph TD; A-->B', false)
    expect(key).toBe(getMermaidRenderKey('graph TD; A-->B', false))
    expect(key).not.toBe(getMermaidRenderKey('graph TD; A-->C', false))
    expect(key).not.toBe(getMermaidRenderKey('graph TD; A-->B', true))
    expect(JSON.parse(key)[0]).toBe('strict-v1')
  })

  it('keeps SVG and dimensions together and evicts the least recently used entry', () => {
    const cache = new MermaidRenderCache(2)
    const first = result()
    cache.set('a', first)
    cache.set('b', result())
    expect(cache.get('a')).toBe(first)
    cache.set('c', result())
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(first)
    expect(cache.get('c')?.size).toEqual({ width: 400, height: 300 })
  })

  it('bounds total string storage including keys, and handles replacement accounting', () => {
    const cache = new MermaidRenderCache(10, 24)
    cache.set('a', result('12345')) // 12 bytes
    cache.set('b', result('12345')) // 12 bytes
    cache.set('a', result('1')) // 4 bytes, replaces the old 12
    cache.set('c', result('12345')) // 12 bytes: evicts b, not a
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')?.svg).toBe('1')
    expect(cache.get('c')?.svg).toBe('12345')
  })

  it('does not retain oversized entries or evict useful entries to make room for them', () => {
    const cache = new MermaidRenderCache(2, 20)
    cache.set('a', result('123'))
    cache.set('oversized', result('x'.repeat(100)))
    expect(cache.get('oversized')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
  })

  it('can be disabled with a zero capacity', () => {
    const cache = new MermaidRenderCache(0)
    cache.set('a', result())
    expect(cache.get('a')).toBeUndefined()
  })
})

describe('Mermaid render loading', () => {
  it('skips queued work when all consumers have unmounted', async () => {
    let active = true
    const render = vi.fn(async () => result())
    const job = loadMermaidRender('abandoned-diagram', render, () => active)
    active = false
    await expect(job).rejects.toThrow('no longer needed')
    expect(render).not.toHaveBeenCalled()
    expect(mermaidRenderCache.get('abandoned-diagram')).toBeUndefined()
  })

  it('keeps deduplicated work when another consumer is still mounted', async () => {
    const render = vi.fn(async () => result())
    const first = loadMermaidRender('shared-live-diagram', render, () => false)
    const second = loadMermaidRender('shared-live-diagram', render, () => true)
    await expect(first).resolves.toEqual(result())
    expect(first).toBe(second)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent work and retains a result even without mounted consumers', async () => {
    const key = 'concurrent-diagram'
    let resolve!: (value: ReturnType<typeof result>) => void
    const render = vi.fn(() => new Promise<ReturnType<typeof result>>(done => { resolve = done }))
    const first = loadMermaidRender(key, render)
    const second = loadMermaidRender(key, render)
    expect(first).toBe(second)
    await Promise.resolve()
    expect(render).toHaveBeenCalledTimes(1)
    const rendered = result()
    resolve(rendered)
    await expect(first).resolves.toBe(rendered)
    expect(mermaidRenderCache.get(key)).toBe(rendered)
    await expect(loadMermaidRender(key, render)).resolves.toBe(rendered)
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('serializes render configuration and does not poison the queue after a failure', async () => {
    const events: string[] = []
    const broken = loadMermaidRender('broken-diagram', async () => {
      events.push('broken')
      throw new Error('invalid diagram')
    })
    const next = loadMermaidRender('next-diagram', async id => {
      events.push('next')
      expect(id).toMatch(/^mermaid-render-\d+$/)
      return result()
    })
    await expect(broken).rejects.toThrow('invalid diagram')
    await expect(next).resolves.toEqual(result())
    expect(events).toEqual(['broken', 'next'])
    const retry = vi.fn(async () => result())
    await loadMermaidRender('broken-diagram', retry)
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
