import { describe, expect, it } from 'vitest'
import { parsePlanCommand } from './planCommand'

describe('parsePlanCommand', () => {
  it('reads /plan alone as a toggle', () => {
    expect(parsePlanCommand('/plan')).toEqual({ task: '' })
    expect(parsePlanCommand('  /PLAN \n')).toEqual({ task: '' })
  })

  it('keeps the task after /plan, including line breaks', () => {
    expect(parsePlanCommand('/plan add caching\n\nto the tree route')).toEqual({ task: 'add caching\n\nto the tree route' })
  })

  it('ignores other commands and paths', () => {
    expect(parsePlanCommand('/planner go')).toBeNull()
    expect(parsePlanCommand('/plan.md review it')).toBeNull()
    expect(parsePlanCommand('make a /plan')).toBeNull()
    expect(parsePlanCommand('/compact')).toBeNull()
  })
})
