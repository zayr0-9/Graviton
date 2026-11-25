import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DISCLOSURE_LABEL_CLASS,
  MONO_KEY_CLASS,
  TOOL_FIELD_KEY_CLASS,
  TOOL_FIELD_LITERAL_CLASS,
  TOOL_FIELD_PUNCTUATION_CLASS,
  TOOL_FIELD_STRING_CLASS,
  TOOL_FIELD_TEXT_CLASS,
} from './chatMessageShared'
import { isPanelCollapseTransitionEnd, resolvePanelChildrenMounted } from './disclosurePanelState'
import { DisclosurePanel, DisclosureRow, FieldRows } from './messagePrimitives'

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

  it.each([false, true])('uses quiet group chrome with expanded=%s', expanded => {
    const html = renderRow('group', expanded)
    expect(html).toContain(DISCLOSURE_LABEL_CLASS)
    expect(html).not.toContain('text-[calc(0.8125em+1pt)]')
    expect(html).toContain('lucide-list-checks')
    expect(html).toContain('rounded-lg')
    expect(html).toContain('width="16"')
    expect(html).toContain('Agent steps')
    expect(html).toContain(`aria-expanded="${expanded}"`)
    // Preserve virtual row height; metadata is smaller than the shared label.
    expect(html).toContain('class="flex h-8')
    if (!expanded) expect(html).toContain('truncate text-[0.75em] leading-tight')
  })
})

const renderPanel = (expanded: boolean, disableTransition = false) => renderToStaticMarkup(
  <DisclosurePanel id='panel' expanded={expanded} disableTransition={disableTransition}>
    <span>hidden detail</span>
  </DisclosurePanel>
)

describe('DisclosurePanel collapsed content', () => {
  it('renders no children while collapsed and marks the content inert', () => {
    const html = renderPanel(false)
    expect(html).not.toContain('hidden detail')
    expect(html).toContain('class="tool-expand-content" inert=""')
  })

  it('renders children while expanded without inert', () => {
    const html = renderPanel(true)
    expect(html).toContain('hidden detail')
    expect(html).not.toContain('inert')
    expect(html).toContain('tool-expand-container open')
  })

  it('still renders nothing while collapsed when the transition is disabled', () => {
    expect(renderPanel(false, true)).not.toContain('hidden detail')
  })
})

describe('resolvePanelChildrenMounted', () => {
  it('mounts children on the opening render, with or without a transition', () => {
    expect(resolvePanelChildrenMounted(true, false, false)).toBe(true)
    expect(resolvePanelChildrenMounted(true, false, true)).toBe(true)
  })

  it('keeps children through an animated close until the transition ends', () => {
    expect(resolvePanelChildrenMounted(false, true, false)).toBe(true)
  })

  it('unmounts at once when the transition is disabled, because no transitionend fires', () => {
    expect(resolvePanelChildrenMounted(false, true, true)).toBe(false)
  })

  it('stays unmounted while collapsed', () => {
    expect(resolvePanelChildrenMounted(false, false, false)).toBe(false)
    expect(resolvePanelChildrenMounted(false, false, true)).toBe(false)
  })
})

describe('isPanelCollapseTransitionEnd', () => {
  const container = {} as EventTarget
  const child = {} as EventTarget

  it('accepts only the container height transition', () => {
    expect(isPanelCollapseTransitionEnd({ target: container, currentTarget: container, propertyName: 'grid-template-rows' })).toBe(true)
  })

  it('ignores bubbled child transitions and other properties', () => {
    expect(isPanelCollapseTransitionEnd({ target: child, currentTarget: container, propertyName: 'grid-template-rows' })).toBe(false)
    expect(isPanelCollapseTransitionEnd({ target: container, currentTarget: container, propertyName: 'opacity' })).toBe(false)
  })
})

const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

describe('FieldRows palette', () => {
  it('colours keys, punctuation and literal values apart from string values', () => {
    const html = renderToStaticMarkup(<FieldRows record={{ path: 'a.ts', count: 3, done: true, missing: null }} />)
    expect(html).toContain(
      `<span class="${TOOL_FIELD_KEY_CLASS}">path</span><span class="${TOOL_FIELD_PUNCTUATION_CLASS}">:</span> <span class="${TOOL_FIELD_TEXT_CLASS}">a.ts</span>`
    )
    expect(html).toContain(`<span class="${TOOL_FIELD_LITERAL_CLASS}">3</span>`)
    expect(html).toContain(`<span class="${TOOL_FIELD_LITERAL_CLASS}">true</span>`)
    expect(html).toContain(`<span class="${TOOL_FIELD_LITERAL_CLASS}">null</span>`)
    expect(textOf(html)).toBe('path: a.tscount: 3done: truemissing: null')
  })

  it('tokenises nested objects without changing their text', () => {
    const call = { tool: 'read_file', args: { path: 'x.ts', lines: 10, follow: false } }
    const html = renderToStaticMarkup(<FieldRows record={{ call }} />)
    expect(html).toContain(`<span class="${TOOL_FIELD_KEY_CLASS}">&quot;tool&quot;</span>`)
    expect(html).toContain(`<span class="${TOOL_FIELD_STRING_CLASS}">&quot;read_file&quot;</span>`)
    expect(html).toContain(`<span class="${TOOL_FIELD_LITERAL_CLASS}">10</span>`)
    expect(html).toContain(`<span class="${TOOL_FIELD_LITERAL_CLASS}">false</span>`)
    expect(textOf(html)).toBe(`call: ${JSON.stringify(call)}`)
  })

  it('renders an oversized nested value as one plain span', () => {
    const big = { items: Array.from({ length: 500 }, (_, i) => ({ i })) }
    const html = renderToStaticMarkup(<FieldRows record={{ big }} />)
    expect(html).not.toContain(TOOL_FIELD_LITERAL_CLASS)
    expect(textOf(html)).toBe(`big: ${JSON.stringify(big)}`)
  })

  it('keeps the legacy muted key when the palette is off', () => {
    const html = renderToStaticMarkup(<FieldRows record={{ error: 'boom' }} palette={false} />)
    expect(html).toContain(`<span class="${MONO_KEY_CLASS}">error:</span> <span>boom</span>`)
    expect(html).not.toContain('tool-field-')
  })

  it('uses the fallback entry when the record is null', () => {
    const html = renderToStaticMarkup(<FieldRows record={null} fallback={{ key: 'content', value: 'plain' }} />)
    expect(html).toContain(`<span class="${TOOL_FIELD_KEY_CLASS}">content</span>`)
    expect(textOf(html)).toBe('content: plain')
  })
})
