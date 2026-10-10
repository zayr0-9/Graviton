import { describe, expect, it } from 'vitest'
import { isExcludedFromProcessRunGrouping } from './chatMessageShared'

describe('isExcludedFromProcessRunGrouping', () => {
  it.each(['mcp__github__search', 'MCP__server__tool', 'html_renderer'])(
    'excludes interactive tool %s',
    name => {
      expect(isExcludedFromProcessRunGrouping(name)).toBe(true)
    }
  )

  it.each(['display', 'visualize', 'visualise', 'clarify'])(
    'excludes plan_md action %s',
    action => {
      expect(isExcludedFromProcessRunGrouping('plan_md', { action })).toBe(true)
    }
  )

  it('keeps non-visual plan and ordinary tools groupable', () => {
    expect(isExcludedFromProcessRunGrouping('plan_md', { action: 'read' })).toBe(false)
    expect(isExcludedFromProcessRunGrouping('read_file', { path: '/tmp/file' })).toBe(false)
  })
})
