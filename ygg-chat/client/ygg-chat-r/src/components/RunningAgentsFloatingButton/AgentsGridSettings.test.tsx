import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsGridSettings, readAgentGridOrderMode, writeAgentGridOrderMode } from './AgentsGridSettings'

const memoryStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

describe('agents grid order preference', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('defaults to moving cards between rows', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    expect(readAgentGridOrderMode()).toBe('rows')
  })

  it('round-trips the locked mode and ignores unknown values', () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    writeAgentGridOrderMode('locked')
    expect(readAgentGridOrderMode()).toBe('locked')
    storage.setItem('agents:gridOrderMode', 'shuffle')
    expect(readAgentGridOrderMode()).toBe('rows')
  })

  it('falls back when storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(readAgentGridOrderMode()).toBe('rows')
    expect(() => writeAgentGridOrderMode('locked')).not.toThrow()
  })
})

describe('AgentsGridSettings', () => {
  it('renders a closed menu button', () => {
    const html = renderToStaticMarkup(<AgentsGridSettings orderMode='rows' onOrderModeChange={() => {}} buttonClassName={open => open ? 'is-open' : 'is-closed'} />)
    expect(html).toContain('aria-label="Grid settings"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('is-closed')
    expect(html).not.toContain('role="menu"')
  })
})
