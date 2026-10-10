import { renderToStaticMarkup } from 'react-dom/server'
import { RotateCw } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { CompactMessageNotice } from './CompactMessageNotice'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

const label = 'That did not go through. Trying again… (1 of 2)'

describe('CompactMessageNotice status', () => {
  it('uses shared system notice chrome and preserves retry text and tooltip', () => {
    const html = renderToStaticMarkup(
      <CompactMessageNotice kind='status' className='!p-0' title={label} customThemeEnabled={false}
        icon={<RotateCw size={14} className='shrink-0' aria-hidden='true' />}>
        {label}
      </CompactMessageNotice>,
    )
    expect(html).toContain('flex h-8 items-center gap-2 px-2.5 text-xs text-stone-500 dark:text-stone-400')
    expect(html).toContain(`title="${label}"`)
    expect(html).toContain(`>${label}</span>`)
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('italic')
    expect(html).not.toContain('data-chat-watcher')
    expect(html).not.toContain('data-chat-summary')
  })

  it('uses the custom theme muted text color', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.toolJobsMutedText.dark = '#123456'
    const html = renderToStaticMarkup(
      <CompactMessageNotice kind='status' title={label} customTheme={theme} customThemeEnabled isDarkMode icon={null}>
        {label}
      </CompactMessageNotice>,
    )
    expect(html).toContain('color:#123456')
  })
})
