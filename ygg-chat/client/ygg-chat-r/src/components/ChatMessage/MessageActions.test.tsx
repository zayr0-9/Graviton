import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createDefaultCustomChatTheme, getThemeModeColor } from '../ThemeManager/themeConfig'
import { MessageActions } from './MessageActions'

const noop = () => {}

const renderActions = (props: Partial<React.ComponentProps<typeof MessageActions>> = {}) => renderToStaticMarkup(
  <MessageActions isEditing={false} isVisible onCopy={noop} onEdit={noop} onBranch={noop} onDelete={noop} modelName='test-model' {...props} />
)

describe('MessageActions custom theme', () => {
  it.each(['pill', 'menu'] as const)('preserves default %s styling when custom themes are disabled', layout => {
    const html = renderActions({ layout, customTheme: createDefaultCustomChatTheme() })
    expect(html).not.toContain('--message-action-')
    expect(html).toContain('text-neutral-500 dark:text-neutral-400')
    expect(html).toContain('hover:bg-emerald-500/12')
  })

  it.each([
    ['pill', false], ['pill', true], ['menu', false], ['menu', true],
  ] as const)('reuses existing theme colours for %s with dark mode=%s', (layout, isDarkMode) => {
    const customTheme = createDefaultCustomChatTheme()
    customTheme.colors.conversationToolbarBg = { light: '#123456', dark: '#654321' }
    customTheme.colors.markdownMutedText = { light: '#abcdef', dark: '#fedcba' }
    const html = renderActions({ layout, isDarkMode, customTheme, customThemeEnabled: true })
    const color = (pair: { light: string; dark: string }) => getThemeModeColor(pair, isDarkMode)
    expect(html).toContain(`background-color:${color(customTheme.colors.conversationToolbarBg)}`)
    expect(html).toContain(`--message-action-text:${color(customTheme.colors.markdownMutedText)}`)
    expect(html).toContain(`--message-action-hover-bg:${color(customTheme.colors.markdownCodeCopyButtonHoverBg)}`)
    expect(html).toContain(`--message-action-hover-text:${color(customTheme.colors.markdownText)}`)
    expect(html).toContain(`--message-action-hover-text:${color(customTheme.colors.toolJobsStatusCompletedText)}`)
    expect(html).toContain(`--message-action-hover-text:${color(customTheme.colors.toolJobsStatusFailedText)}`)
    expect(html).not.toContain('hover:bg-emerald-500/12')
  })

  it('uses the existing success colour for copied feedback', () => {
    const customTheme = createDefaultCustomChatTheme()
    const html = renderActions({ customTheme, customThemeEnabled: true, copied: true })
    expect(html).toContain(`color:${customTheme.colors.toolJobsStatusCompletedText.light}`)
    expect(html).toContain('aria-label="Copied"')
  })

  it('themes selection and editing action tones', () => {
    const customTheme = createDefaultCustomChatTheme()
    const props = { customTheme, customThemeEnabled: true }
    const selection = renderActions({ ...props, variant: 'selection', onExplainSelection: noop, onAddToNoteSelection: noop })
    expect(selection).toContain(`--message-action-hover-text:${customTheme.colors.toolJobsStatusRunningText.light}`)
    expect(selection).toContain(`--message-action-hover-text:${customTheme.colors.toolJobsStatusPendingText.light}`)
    const editing = renderActions({ ...props, isEditing: true, onSave: noop, onCancel: noop })
    expect(editing).toContain(`--message-action-hover-text:${customTheme.colors.toolJobsStatusCompletedText.light}`)
    expect(editing).toContain(`--message-action-hover-text:${customTheme.colors.toolJobsStatusFailedText.light}`)
  })
})
