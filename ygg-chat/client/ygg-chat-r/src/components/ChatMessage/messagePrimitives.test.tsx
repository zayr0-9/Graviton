import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DISCLOSURE_LABEL_CLASS } from './chatMessageShared'
import { DisclosureRow } from './messagePrimitives'

const renderRow = (labelSize?: 'default' | 'group', expanded = false) => renderToStaticMarkup(
  <DisclosureRow
    label={labelSize === 'group' ? 'Agent steps' : 'read_file'}
    labelSize={labelSize}
    summary='3 tools'
    expanded={expanded}
    onToggle={() => {}}
  />
)

describe('DisclosureRow label sizing', () => {
  it('preserves ordinary step label typography', () => {
    const html = renderRow()
    expect(html).toContain(DISCLOSURE_LABEL_CLASS)
    expect(html).not.toContain('text-[calc(0.8125em+1pt)]')
  })

  it.each([false, true])('makes group labels 1pt larger with expanded=%s', expanded => {
    const html = renderRow('group', expanded)
    expect(html).toContain('text-[calc(0.8125em+1pt)] font-medium leading-tight')
    expect(html).toContain('Agent steps')
    expect(html).toContain(`aria-expanded="${expanded}"`)
    // Increasing the heading does not scale the summary or the entire row.
    expect(html).toContain('class="flex h-8')
    if (!expanded) expect(html).toContain('truncate text-[0.8125em] leading-none')
  })
})
