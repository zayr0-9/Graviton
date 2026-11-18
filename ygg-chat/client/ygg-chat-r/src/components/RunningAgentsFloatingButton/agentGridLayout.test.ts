import { describe, expect, it } from 'vitest'
import { arrangeAgentGridRows, type AgentGridLayout } from './agentGridLayout'

const layout = (columns: number, rows: string[][]): AgentGridLayout => ({ columns, rows })

describe('arrangeAgentGridRows (rows mode)', () => {
  it('chunks sort order when there is no previous layout', () => {
    expect(arrangeAgentGridRows(null, ['a', 'b', 'c', 'd'], 3, 'rows')).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('moves a newly active card up a row without shuffling the columns of cards that stay', () => {
    const previous = layout(3, [['a', 'b', 'c'], ['d', 'e', 'f']])
    // e became active and sorts first; c drops to the second row.
    const rows = arrangeAgentGridRows(previous, ['e', 'a', 'b', 'c', 'd', 'f'], 3, 'rows')
    expect(rows[0]).toEqual(['a', 'b', 'e'])
    expect(rows[1]).toEqual(['d', 'c', 'f'])
  })

  it('keeps a row untouched when only the sort order inside it changes', () => {
    const previous = layout(3, [['a', 'b', 'c']])
    expect(arrangeAgentGridRows(previous, ['c', 'b', 'a'], 3, 'rows')).toEqual([['a', 'b', 'c']])
  })

  it('keeps the relative order of survivors when a row shrinks', () => {
    const previous = layout(3, [['a', 'b', 'c'], ['d', 'e', 'f']])
    expect(arrangeAgentGridRows(previous, ['a', 'b', 'c', 'e', 'f'], 3, 'rows')).toEqual([['a', 'b', 'c'], ['e', 'f']])
  })

  it('reflows from sort order when the column count changes', () => {
    const previous = layout(3, [['a', 'b', 'c']])
    expect(arrangeAgentGridRows(previous, ['c', 'b', 'a'], 2, 'rows')).toEqual([['c', 'b'], ['a']])
  })
})

describe('arrangeAgentGridRows (locked mode)', () => {
  it('ignores sort order changes', () => {
    const previous = layout(3, [['a', 'b', 'c'], ['d']])
    expect(arrangeAgentGridRows(previous, ['d', 'c', 'b', 'a'], 3, 'locked')).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('drops departed cards in place and appends new forks to the last row', () => {
    const previous = layout(3, [['a', 'b', 'c'], ['d']])
    expect(arrangeAgentGridRows(previous, ['x', 'y', 'z', 'a', 'c', 'd'], 3, 'locked'))
      .toEqual([['a', 'c'], ['d', 'x', 'y'], ['z']])
  })

  it('removes rows that become empty', () => {
    const previous = layout(2, [['a', 'b'], ['c'], ['d']])
    expect(arrangeAgentGridRows(previous, ['a', 'b', 'd'], 2, 'locked')).toEqual([['a', 'b'], ['d']])
  })

  it('reflows the locked order (not sort order) when the column count changes', () => {
    const previous = layout(2, [['a', 'b'], ['c']])
    expect(arrangeAgentGridRows(previous, ['c', 'b', 'a', 'n'], 3, 'locked')).toEqual([['a', 'b', 'c'], ['n']])
  })
})
