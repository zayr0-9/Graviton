import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY,
  loadDefaultToolAutoApprove,
  saveDefaultToolAutoApprove,
} from './toolApprovalSettingsStorage'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('default tool approval', () => {
  it('defaults to Ask when no preference is saved', () => {
    expect(loadDefaultToolAutoApprove()).toBe(false)
  })

  it('persists Allow all and Ask across subsequent loads', () => {
    saveDefaultToolAutoApprove(true)
    expect(localStorage.getItem(DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY)).toBe('true')
    expect(loadDefaultToolAutoApprove()).toBe(true)
    saveDefaultToolAutoApprove(false)
    expect(loadDefaultToolAutoApprove()).toBe(false)
  })

  it.each(['invalid', '1', 'TRUE', '{}'])('fails closed for invalid stored value %s', value => {
    localStorage.setItem(DEFAULT_TOOL_AUTO_APPROVE_STORAGE_KEY, value)
    expect(loadDefaultToolAutoApprove()).toBe(false)
  })

  it('handles unavailable storage', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadDefaultToolAutoApprove()).toBe(false)
    expect(() => saveDefaultToolAutoApprove(true)).not.toThrow()
  })

  it('handles storage access failures', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage blocked') },
      setItem: () => { throw new Error('Storage blocked') },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(loadDefaultToolAutoApprove()).toBe(false)
    expect(() => saveDefaultToolAutoApprove(true)).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
  })

  it.each([true, false])('initializes Chat approval from the saved default %s', async enabled => {
    saveDefaultToolAutoApprove(enabled)
    vi.resetModules()
    const { chatSlice, chatSliceActions } = await import('../features/chats/chatSlice')
    const state = chatSlice.reducer(undefined, { type: '@@INIT' })
    expect(state.toolAutoApprove).toBe(enabled)
    const toggled = chatSlice.reducer(state, chatSliceActions.toolAutoApproveToggled())
    expect(toggled.toolAutoApprove).toBe(!enabled)
    expect(loadDefaultToolAutoApprove()).toBe(enabled)
  })
})
