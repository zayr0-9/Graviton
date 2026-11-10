import { afterEach, expect, it, vi } from 'vitest'
import { opaqueAppBackground } from './opaqueAppBackground'
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('uses a solid fallback without relative-color support (dark=%s)', dark => {
  vi.stubGlobal('CSS', { supports: (_property: string, value: string) => !value.startsWith('rgb(from') })
  expect(opaqueAppBackground('rgba(18,52,86,0.1)', dark)).toBe(dark ? '#0C0A09' : '#F5F5F4')
})
it('stays solid when CSS.supports is unavailable', () => {
  vi.stubGlobal('CSS', undefined)
  expect(opaqueAppBackground('#123456', true)).toBe('#0C0A09')
})
it.each(['transparent', 'var(--missing)', 'inherit', 'currentColor', 'env(foo)', 'attr(foo)'])('rejects unresolved color %s', color => {
  vi.stubGlobal('CSS', { supports: () => true })
  expect(opaqueAppBackground(color, true)).toBe('#0C0A09')
})
