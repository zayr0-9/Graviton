import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentsViewSwitch } from './AgentsViewSwitch'

describe('agents view switch', () => {
  it.each([true, false])('marks only the chosen view active (grid=%s)', gridView => {
    const html = renderToStaticMarkup(<AgentsViewSwitch gridView={gridView} onChange={() => {}} />)
    expect(html.indexOf('Live grid view')).toBeLessThan(html.indexOf('List view'))
    expect(html).toMatch(new RegExp(`aria-label="Live grid view"[^>]*aria-pressed="${gridView}"`))
    expect(html).toMatch(new RegExp(`aria-label="List view"[^>]*aria-pressed="${!gridView}"`))
    expect(html.match(/bg-blue-50/g)).toHaveLength(1)
  })

  it('routes each button to its explicit mode, not a toggle, and blocks header collapse', () => {
    const onChange = vi.fn()
    const element = AgentsViewSwitch({ gridView: true, onChange })
    const buttons = element.props.children
    buttons[0].props.onClick()
    expect(onChange).toHaveBeenLastCalledWith(true)
    buttons[1].props.onClick()
    expect(onChange).toHaveBeenLastCalledWith(false)
    const stopPropagation = vi.fn()
    element.props.onClick({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
  })
})
