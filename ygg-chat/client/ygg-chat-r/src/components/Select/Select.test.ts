import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source contracts cover the portaled shell; renderer tests run without a DOM.
const source = readFileSync(new URL('./Select.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./select.css', import.meta.url), 'utf8')

describe('Shared dropdown design contracts', () => {
  it('resolves the shared theme palette on the portal, only when enabled', () => {
    expect(source).toContain('const dropdownThemeStyle = customThemeEnabled\n    ? getActionPopoverThemeStyle(customTheme, isDarkMode)\n    : undefined')
    expect(source).toContain('...dropdownThemeStyle,')
    for (const token of ['surface', 'text', 'field', 'muted', 'button', 'button-text', 'active-bg', 'active-text']) {
      expect(css).toContain(`var(--cloud-${token}`)
    }
  })

  it('uses a borderless shell with distinct field and selected fills', () => {
    expect(css).toContain('border-radius: 26px')
    expect(css).toContain(".select-cloud-row[data-selected='true']")
    expect(css).toContain('background: var(--cloud-active-bg)')
    expect(source).not.toMatch(/shadow-xl|border-neutral-/)
    expect(source).toContain("aria-label='Search options'")
    expect(source).toContain('aria-selected={isSelected}')
    expect(source).toContain('aria-disabled={optDisabled}')
  })

  it('preserves reduced motion, keyboard selection guards and focus visibility', () => {
    expect(source).toContain('prefersReducedMotion ? reducedMotionTransition : shellSpringTransition')
    expect(source).toContain('if (opt) handleSelect(opt.value)')
    expect(source).toContain('if (disabled || isOptionDisabled(val)) return')
    expect(css).toContain('button:focus-visible')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
