import { describe, expect, it } from 'vitest'
import { claudePlanFromToolCall, isExcludedFromProcessRunGrouping } from './chatMessageShared'

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

describe('claudePlanFromToolCall', () => {
  it('surfaces the plan attached to Claude ExitPlanMode and keeps it out of step groups', () => {
    const args = { plan: '# Ship it', planFilePath: '/repo/.ygg/plans/soft-gem.md' }
    expect(claudePlanFromToolCall('ExitPlanMode', args)).toEqual({ name: 'soft-gem', plan: '# Ship it', path: '/repo/.ygg/plans/soft-gem.md' })
    expect(isExcludedFromProcessRunGrouping('ExitPlanMode', args)).toBe(true)
  })

  it('ignores ExitPlanMode calls without a plan and other tools', () => {
    expect(claudePlanFromToolCall('ExitPlanMode', {})).toBeNull()
    expect(claudePlanFromToolCall('Write', { plan: '# no' })).toBeNull()
    expect(isExcludedFromProcessRunGrouping('ExitPlanMode', {})).toBe(false)
  })
})
