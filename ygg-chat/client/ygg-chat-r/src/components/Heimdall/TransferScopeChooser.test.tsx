import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TransferScopeChooser } from './TransferScopeChooser'

const render = (overrides: Partial<Parameters<typeof TransferScopeChooser>[0]> = {}) => renderToStaticMarkup(
  <TransferScopeChooser
    action='copy'
    selectionCount={1}
    branchCount={24}
    branchMoveBlocked={false}
    itemClassName='item'
    onBack={() => {}}
    onSelect={() => {}}
    {...overrides}
  />
)

describe('TransferScopeChooser', () => {
  it('renders direct scope choices with counts and a back button', () => {
    const html = render()
    expect(html).toContain('aria-label="Copy to existing chat"')
    expect(html).toContain('Selected message</span>')
    expect(html).toContain('Current active branch</span>')
    expect(html).toContain('>24</span>')
    expect(html).toContain('>Back</span>')
    expect(html).not.toContain('disabled=""')
  })

  it('labels multi-selection and new-chat actions accurately', () => {
    const html = render({ action: 'new', selectionCount: 3 })
    expect(html).toContain('aria-label="New chat from"')
    expect(html).toContain('Selected messages</span>')
    expect(html).toContain('>3</span>')
  })

  it('disables unsafe branch moves and explains why without blocking selection', () => {
    const html = render({ action: 'move', branchMoveBlocked: true })
    expect(html).toContain('aria-label="Move to existing chat"')
    expect(html.match(/disabled=""/g)).toHaveLength(1)
    expect(html).toContain('aria-describedby="heimdall-branch-move-warning"')
    expect(html).toContain('Moving this branch would delete messages on other branches. Use copy instead.')
  })

  it('inherits custom theme colors for choices and explanatory text', () => {
    const html = render({ itemStyle: { color: '#123456' }, mutedStyle: { color: '#789abc' } })
    expect(html).toContain('color:#123456')
    expect(html).toContain('color:#789abc')
  })
})
