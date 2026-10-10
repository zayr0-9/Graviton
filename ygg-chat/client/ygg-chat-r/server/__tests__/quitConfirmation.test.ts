import { describe, expect, it, vi } from 'vitest'
import { createQuitConfirmationGuard } from '../../electron/quitConfirmation.js'

// This suite runs without Electron, like the other host-shell helper tests.
describe('macOS quit confirmation', () => {
  it('allows quitting only when the user confirms', () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const guard = createQuitConfirmationGuard({ platform: 'darwin', isReady: () => true, confirm })

    expect(guard()).toBe(false)
    expect(guard()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('asks again after cancelling a previous quit request', () => {
    const confirm = vi.fn(() => false)
    const guard = createQuitConfirmationGuard({ platform: 'darwin', isReady: () => true, confirm })

    expect(guard()).toBe(false)
    expect(guard()).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it.each(['win32', 'linux'] as const)('does not prompt on %s', platform => {
    const confirm = vi.fn(() => false)
    const guard = createQuitConfirmationGuard({ platform, isReady: () => true, confirm })

    expect(guard()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('allows quitting before app readiness without opening a dialog', () => {
    const confirm = vi.fn(() => false)
    const guard = createQuitConfirmationGuard({ platform: 'darwin', isReady: () => false, confirm })

    expect(guard()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('rejects reentrant requests without opening a second dialog', () => {
    let guard: () => boolean
    const confirm = vi.fn(() => {
      expect(guard()).toBe(false)
      return true
    })
    guard = createQuitConfirmationGuard({ platform: 'darwin', isReady: () => true, confirm })

    expect(guard()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('resets the dialog guard if confirmation throws', () => {
    const confirm = vi.fn()
      .mockImplementationOnce(() => { throw new Error('Dialog failed') })
      .mockReturnValueOnce(true)
    const guard = createQuitConfirmationGuard({ platform: 'darwin', isReady: () => true, confirm })

    expect(() => guard()).toThrow('Dialog failed')
    expect(guard()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
})
