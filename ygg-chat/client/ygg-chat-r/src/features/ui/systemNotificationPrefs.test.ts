import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_NOTIFICATION_PREFS,
  readSystemNotificationPrefs,
  SYSTEM_NOTIFICATIONS_ENABLED_KEY,
  SYSTEM_NOTIFICATIONS_WHEN_KEY,
  writeSystemNotificationPrefs,
} from './systemNotificationPrefs'

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

const installStorage = () => {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
      removeItem: (key: string) => { data.delete(key) },
      clear: () => data.clear(),
    },
  })
  return data
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('system notification prefs', () => {
  let data: Map<string, string>
  beforeEach(() => { data = installStorage() })

  it('defaults to on, only when unfocused', () => {
    expect(readSystemNotificationPrefs()).toEqual({ enabled: true, when: 'unfocused' })
  })

  it('persists changes and merges partial updates', () => {
    expect(writeSystemNotificationPrefs({ when: 'always' })).toEqual({ enabled: true, when: 'always' })
    expect(writeSystemNotificationPrefs({ enabled: false })).toEqual({ enabled: false, when: 'always' })
    expect(data.get(SYSTEM_NOTIFICATIONS_ENABLED_KEY)).toBe('false')
    expect(readSystemNotificationPrefs()).toEqual({ enabled: false, when: 'always' })
  })

  it('falls back to the default for an invalid stored choice', () => {
    data.set(SYSTEM_NOTIFICATIONS_WHEN_KEY, 'sometimes')
    expect(readSystemNotificationPrefs().when).toBe('unfocused')
  })

  it('uses defaults without storage', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(readSystemNotificationPrefs()).toEqual(DEFAULT_SYSTEM_NOTIFICATION_PREFS)
  })
})
