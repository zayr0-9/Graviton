import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ConversationOpeningOverlay } from './ConversationOpeningOverlay'

it('does not render after selection settles', () => {
  expect(renderToStaticMarkup(<ConversationOpeningOverlay visible={false} />)).toBe('')
})

it('renders an accessible pane-relative loading card without a viewport modal or focus trap', () => {
  const html = renderToStaticMarkup(<ConversationOpeningOverlay visible />)
  expect(html).toContain('Opening conversation…')
  expect(html).toContain('role="status"')
  expect(html).toContain('aria-live="polite"')
  expect(html).toContain('absolute inset-0')
  expect(html).toContain('items-center justify-center')
  expect(html).toContain('motion-safe:animate-spin')
  expect(html).not.toContain('fixed')
  expect(html).not.toContain('aria-modal')
  expect(html).not.toContain('autofocus')
})
