import { describe, expect, it } from 'vitest'
import { getAgentGridColumns, getAgentGridTracks, resizeAgentGridSplit } from './agentGridSplit'

describe('agent grid responsive columns', () => {
  it.each([
    [1200, 700, 16, 6, 1],
    [1200, 1000, 16, 6, 2],
    [1200, 1400, 16, 6, 3],
    [887, 1400, 16, 6, 2],
    [888, 1400, 16, 6, 3],
    [580, 1400, 16, 6, 1],
    [588, 1400, 16, 6, 2],
    [1200, 1400, 16, 1, 1],
    [0, 1400, 16, 0, 1],
    [1000, 1400, 20, 6, 2],
  ])('resolves width %s, viewport %s, rem %s, count %s to %s columns', (width, viewport, rem, count, expected) => {
    expect(getAgentGridColumns(width, viewport, rem, count)).toBe(expected)
  })
})

describe('row-local split geometry', () => {
  it('changes only the neighboring pair, without mutating this or any other row', () => {
    const row = [0.3, 0.3, 0.4]
    const otherRow = [0.5, 0.5]
    const next = resizeAgentGridSplit(row, 0, 100, 1000)
    expect(next[0]).toBeCloseTo(0.4)
    expect(next[1]).toBeCloseTo(0.2)
    expect(next[2]).toBe(0.4)
    expect(row).toEqual([0.3, 0.3, 0.4])
    expect(otherRow).toEqual([0.5, 0.5])
    expect(next.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('clamps both sides to 160px without changing the third pane', () => {
    const rightLimit = resizeAgentGridSplit([0.3, 0.3, 0.4], 0, 9999, 1000)
    expect(rightLimit[0]).toBeCloseTo(0.44)
    expect(rightLimit[1]).toBeCloseTo(0.16)
    expect(rightLimit[2]).toBe(0.4)
    const next = resizeAgentGridSplit([0.3, 0.3, 0.4], 1, -9999, 1000)
    expect(next[0]).toBe(0.3)
    expect(next[1]).toBeCloseTo(0.16)
    expect(next[2]).toBeCloseTo(0.54)
  })

  it('fits tiny containers without negative or overflowing tracks', () => {
    const next = resizeAgentGridSplit([0.5, 0.5], 0, 9999, 200)
    expect(next).toEqual([0.5, 0.5])
  })

  it('ignores absent dividers and unmeasured containers', () => {
    const row = [1]
    expect(resizeAgentGridSplit(row, 0, 50, 1000)).toBe(row)
    expect(resizeAgentGridSplit([0.5, 0.5], 0, 50, 0)).toEqual([0.5, 0.5])
  })
})

describe('full-width row tracks', () => {
  it.each([
    [1 / 3, 1 / 3, 1 / 3],
    [0.16, 0.3, 0.54],
    [0.1, 0.1, 0.8],
    [0.16, 0.84],
    [1],
  ])('keeps every flexible track at least 1fr for ratios %j', (...ratios) => {
    const tracks = getAgentGridTracks(ratios)
    const factors = [...tracks.matchAll(/([\d.]+)fr/g)].map(match => Number(match[1]))
    expect(factors).toHaveLength(ratios.length)
    expect(Math.min(...factors)).toBe(1)
    const total = factors.reduce((sum, factor) => sum + factor, 0)
    factors.forEach((factor, index) => expect(factor / total).toBeCloseTo(ratios[index]))
  })

  it('fills remaining space when a narrow card reaches its minimum', () => {
    expect(getAgentGridTracks([0.125, 0.25, 0.625])).toBe(
      'minmax(min(160px, 100%), 1fr) minmax(min(160px, 100%), 2fr) minmax(min(160px, 100%), 5fr)'
    )
  })
})
