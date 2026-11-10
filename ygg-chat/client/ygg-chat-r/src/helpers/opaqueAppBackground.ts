export const SOLID_BACKGROUND_COLORS = { light: '#F5F5F4', dark: '#0C0A09' }

/** Browser canvas must never inherit native glass/alpha, including custom themes. */
export function opaqueAppBackground(color: string, dark: boolean): string {
  const fallback = dark ? SOLID_BACKGROUND_COLORS.dark : SOLID_BACKGROUND_COLORS.light
  const value = color.trim()
  if (!value || /^(transparent|inherit|initial|unset|revert|revert-layer|currentcolor)$/i.test(value) || /\b(?:var|env|attr)\s*\(/i.test(value)) return fallback
  if (typeof CSS !== 'undefined' && !CSS.supports('color', value)) return fallback
  // Relative RGB preserves supported color spaces but must itself be supported.
  // Older browsers get a guaranteed solid fallback, never an invalid CSS value.
  if (typeof CSS === 'undefined' || !CSS.supports('color', 'rgb(from red r g b / 1)')) return fallback
  return `rgb(from ${value} r g b / 1)`
}
