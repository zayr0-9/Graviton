import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SummaryBranchMessage } from './SummaryBranchMessage'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

vi.mock('react-redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) => selector({
    chat: { composition: { editingBranch: false, branchEditMessageId: null } },
  }),
}))
vi.mock('../../features/chats/chatSlice', () => ({ chatSliceActions: {} }))
vi.mock('../TextArea/TextArea', () => ({ TextArea: () => null }))

const props = { id: 'summary', role: 'assistant' as const, content: 'Hidden summary', width: 'w-full' as const, customThemeEnabled: false }

describe('SummaryBranchMessage', () => {
  it('renders the branch pill inside the summary notice row', () => {
    const html = renderToStaticMarkup(<SummaryBranchMessage {...props} onBranch={vi.fn()} />)
    expect(html).toContain('Conversation summarised</span><button')
    expect(html).toContain('>branch here</button></div></div>')
    expect(html).toContain('type="button"')
    expect(html).toContain('rounded-full')
    expect(html).toContain('focus-visible:ring-2')
    expect(html).toContain('motion-reduce:transition-none')
    expect(html).not.toContain('Branch from summary')
    expect(html).not.toContain('Hidden summary')
  })

  it('renders the branch-before-summary pill only when it has a handler', () => {
    const html = renderToStaticMarkup(<SummaryBranchMessage {...props} onBranch={vi.fn()} onBranchBeforeSummary={vi.fn()} />)
    expect(html).toContain('>branch before summary</button><button')
    expect(html).toContain('>branch here</button>')
    expect(renderToStaticMarkup(<SummaryBranchMessage {...props} onBranch={vi.fn()} />)).not.toContain('branch before summary')
    expect(renderToStaticMarkup(<SummaryBranchMessage {...props} readOnly onBranchBeforeSummary={vi.fn()} />)).not.toContain('<button')
  })

  it('omits the action for read-only or non-branchable summaries', () => {
    expect(renderToStaticMarkup(<SummaryBranchMessage {...props} readOnly onBranch={vi.fn()} />)).not.toContain('<button')
    expect(renderToStaticMarkup(<SummaryBranchMessage {...props} />)).not.toContain('<button')
  })

  it.each([false, true])('themes the button and hover colors in dark mode %s', isDarkMode => {
    const theme = createDefaultCustomChatTheme()
    const mode = isDarkMode ? 'dark' : 'light'
    theme.colors.settingsCustomThemesButtonBg[mode] = '#123456'
    theme.colors.settingsCustomThemesButtonText[mode] = '#abcdef'
    theme.colors.composerToggleActiveBg[mode] = '#234567'
    theme.colors.composerToggleActiveText[mode] = '#fedcba'
    const html = renderToStaticMarkup(<SummaryBranchMessage {...props} onBranch={vi.fn()}
      customTheme={theme} customThemeEnabled isDarkMode={isDarkMode} />)
    expect(html).toContain('--summary-action-bg:#123456')
    expect(html).toContain('--summary-action-text:#abcdef')
    expect(html).toContain('--summary-action-hover-bg:#234567')
    expect(html).toContain('--summary-action-hover-text:#fedcba')
  })
})
