import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({ dialog: null as any, cleanup: undefined as undefined | (() => void) }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: (value: unknown) => ({ current: value === null ? lifecycle.dialog : value }),
  useEffect: (effect: () => () => void) => { lifecycle.cleanup = effect() },
}))
vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ enabled: true, theme: { colors: new Proxy({}, { get: (_, key) => String(key) }) } }),
  useHtmlDarkMode: () => false,
  getThemeModeColor: (value: string) => value,
}))
import { ModelSwitchDialog } from './ModelSwitchDialog'

let frame: () => void
let reduced = false
function mount() {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const tree = ModelSwitchDialog({ from: { provider: 'A', model: 'a' }, to: { provider: 'B', model: 'b' }, onCancel, onConfirm })
  const buttons = tree.props.children.at(-1).props.children
  return { tree, buttons, onCancel, onConfirm }
}
beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  lifecycle.dialog = { classList: { add: vi.fn(), remove: vi.fn() }, showModal: vi.fn(), close: vi.fn(), offsetWidth: 1 }
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '150ms' }))
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) })
})
afterEach(() => { lifecycle.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('model switch modal motion', () => {
  it('opens in the top layer before entering and uses existing theme colors', () => {
    const { tree, buttons } = mount()
    expect(lifecycle.dialog.showModal).toHaveBeenCalledOnce()
    expect(lifecycle.dialog.classList.add).not.toHaveBeenCalled()
    frame()
    expect(lifecycle.dialog.classList.add).toHaveBeenCalledWith('is-open')
    expect(tree.props.style['--switch-primary-bg']).toBe('authModalPrimaryButtonBg')
    expect(tree.props.style['--switch-backdrop']).toBe('authModalBackdrop')
    expect(buttons[0].props.autoFocus).toBe(true)
  })
  it('animates out before confirming and prevents duplicate activation', () => {
    const { buttons, onConfirm } = mount()
    frame()
    buttons[1].props.onClick()
    buttons[1].props.onClick()
    expect(lifecycle.dialog.classList.add).toHaveBeenCalledWith('is-closing')
    expect(onConfirm).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(lifecycle.dialog.close).toHaveBeenCalledOnce()
  })
  it('Escape follows the same animated cancel path', () => {
    const { tree, onCancel } = mount()
    const preventDefault = vi.fn()
    tree.props.onCancel({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(onCancel).toHaveBeenCalledOnce()
  })
  it('skips the delay for reduced motion and cancels timers on unmount', () => {
    reduced = true
    const { buttons, onConfirm } = mount()
    buttons[1].props.onClick()
    vi.advanceTimersByTime(0)
    expect(onConfirm).toHaveBeenCalledOnce()
    const other = mount()
    other.buttons[1].props.onClick()
    lifecycle.cleanup?.()
    vi.runAllTimers()
    expect(other.onConfirm).not.toHaveBeenCalled()
  })
})
