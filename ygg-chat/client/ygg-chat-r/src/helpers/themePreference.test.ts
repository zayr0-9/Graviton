import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeThemePreference, setThemePreference } from './themePreference'

function setup(saved: string | null, systemDark = false) {
  const media = Object.assign(new EventTarget(), { matches: systemDark })
  const toggle = vi.fn()
  const update = vi.fn()
  const localStorage = {
    getItem: vi.fn(() => saved),
    setItem: vi.fn((_key: string, value: string) => { saved = value }),
  }
  const browser = Object.assign(new EventTarget(), {
    localStorage,
    matchMedia: vi.fn(() => media),
    electronAPI: { theme: { update } },
  })
  vi.stubGlobal('window', browser)
  vi.stubGlobal('document', { documentElement: { classList: { toggle } } })

  const changeAppearance = (dark: boolean) => {
    media.matches = dark
    media.dispatchEvent(new Event('change'))
  }
  const changeStoredPreference = (preference: string | null, key: string | null = 'theme') => {
    saved = preference
    browser.dispatchEvent(Object.assign(new Event('storage'), { key }))
  }

  return { changeAppearance, changeStoredPreference, localStorage, toggle, update }
}

afterEach(() => vi.unstubAllGlobals())

describe('theme preference', () => {
  it.each(['system', null])('follows live system appearance changes with stored preference %s', saved => {
    const { changeAppearance, toggle, update } = setup(saved)
    initializeThemePreference()
    expect(update).toHaveBeenCalledWith('system')
    expect(toggle).toHaveBeenLastCalledWith('dark', false)

    changeAppearance(true)
    expect(toggle).toHaveBeenLastCalledWith('dark', true)
    changeAppearance(false)
    expect(toggle).toHaveBeenLastCalledWith('dark', false)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it.each(['light', 'dark'])('keeps explicit %s until the preference is changed back to System', saved => {
    const { changeAppearance, localStorage, toggle, update } = setup(saved, saved === 'light')
    initializeThemePreference()
    expect(update).toHaveBeenCalledWith(saved)
    expect(toggle).toHaveBeenLastCalledWith('dark', saved === 'dark')

    changeAppearance(saved === 'dark')
    expect(toggle).toHaveBeenCalledTimes(1)

    setThemePreference('system')
    expect(localStorage.setItem).toHaveBeenCalledWith('theme', 'system')
    expect(update).toHaveBeenLastCalledWith('system')

    changeAppearance(saved === 'light')
    expect(toggle).toHaveBeenLastCalledWith('dark', saved === 'light')
  })

  it('updates explicit preferences from storage events and stops listening on disposal', () => {
    const { changeAppearance, changeStoredPreference, toggle, update } = setup('light', true)
    const dispose = initializeThemePreference()

    changeStoredPreference('system')
    expect(update).toHaveBeenLastCalledWith('system')
    expect(toggle).toHaveBeenLastCalledWith('dark', true)

    dispose()
    changeAppearance(false)
    changeStoredPreference('dark')
    expect(toggle).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledTimes(2)
  })
})
