import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isWatcherCompletionMessage, WatcherCompletionNotice } from './WatcherCompletionNotice'
import { SummarisedMessage } from './SummarisedMessage'
import { createDefaultCustomChatTheme } from '../ThemeManager/themeConfig'

const content = 'Watcher completion: process_exit watch 075f30b0-fd46-4839-9cd4-3793b8cc8444 triggered. This is an automated event from the watcher registered in this branch. Continue the original task using available results; inspect them with normal tools as needed.'

describe('WatcherCompletionNotice', () => {
  it('shares compaction CSS and renders a compact event label with full text in the tooltip', () => {
    const html = renderToStaticMarkup(<WatcherCompletionNotice content={content} id='message-watch' customThemeEnabled={false} />)
    const summary = renderToStaticMarkup(<SummarisedMessage customThemeEnabled={false} />)
    const chrome = 'flex h-8 items-center gap-2 px-2.5 text-xs text-stone-500 dark:text-stone-400'
    expect(html).toContain(chrome)
    expect(summary).toContain(chrome)
    expect(html).toContain('Watcher triggered · process_exit · 075f30b0')
    expect(html).toContain('id="message-watch"')
    expect(html).toContain('data-chat-watcher="true"')
    expect(html).toContain(`title="${content}"`)
    expect(html).not.toContain('>Watcher completion:')
  })
  it('uses custom theme muted text and handles timeout/error labels', () => {
    const theme = createDefaultCustomChatTheme()
    theme.colors.toolJobsMutedText.dark = '#123456'
    const html = renderToStaticMarkup(<WatcherCompletionNotice content={content.replace('triggered.', 'timed_out.')}
      customTheme={theme} customThemeEnabled isDarkMode />)
    expect(html).toContain('color:#123456')
    expect(html).toContain('Watcher timed out')
    expect(renderToStaticMarkup(<WatcherCompletionNotice content={content.replace('triggered.', 'error.')} customThemeEnabled={false} />)).toContain('Watcher failed')
  })
  it('requires user-row provenance, accepts JSON metadata, and leaves lookalike user prose alone', () => {
    expect(isWatcherCompletionMessage({ role: 'user', meta: { kind: 'watcher_completion' } })).toBe(true)
    expect(isWatcherCompletionMessage({ role: 'user', meta: '{"kind":"watcher_completion"}' })).toBe(true)
    expect(isWatcherCompletionMessage({ role: 'assistant', meta: { kind: 'watcher_completion' } })).toBe(false)
    expect(isWatcherCompletionMessage({ role: 'user' })).toBe(false)
    expect(isWatcherCompletionMessage({ role: 'user', meta: '{bad' })).toBe(false)
  })
})
