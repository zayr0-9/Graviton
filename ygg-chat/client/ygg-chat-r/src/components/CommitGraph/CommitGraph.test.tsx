import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LocalGitCommit } from '../../../shared/localGit'
import { CommitGraph } from './CommitGraph'
import { buildCommitGraph } from './commitGraphLayout'

const commit = (hash: string, parents?: string[]): LocalGitCommit => ({
  hash, parents, shortHash: hash, author: 'Author', relativeDate: 'yesterday', decorations: '', subject: `Commit ${hash}`,
})

describe('commit graph', () => {
  it('keeps linear history in one lane and stops at the root', () => {
    const { rows, laneCount } = buildCommitGraph([commit('a', ['b']), commit('b', ['c']), commit('c', [])])
    expect(laneCount).toBe(1)
    expect(rows.map(row => row.lane)).toEqual([0, 0, 0])
    expect(rows.map(row => row.color)).toEqual([0, 0, 0])
    expect(rows[0].edges.filter(edge => edge.half === 'top')).toEqual([])
    expect(rows[1].edges).toHaveLength(2)
    expect(rows[2].edges).toEqual([{ from: 0, to: 0, color: 0, half: 'top' }])
  })

  it('splits merges into colored lanes and reconnects the shared ancestor', () => {
    const { rows, laneCount } = buildCommitGraph([
      commit('merge', ['main', 'branch']), commit('branch', ['root']), commit('main', ['root']), commit('root', []),
    ])
    expect(laneCount).toBe(2)
    expect(rows.map(row => row.lane)).toEqual([0, 1, 0, 1])
    expect(rows[0].edges).toContainEqual({ from: 0, to: 1, color: 1, half: 'bottom' })
    expect(rows[2].edges).toContainEqual({ from: 0, to: 1, color: 1, half: 'bottom' })
    // The destination lane must continue through the row where another lane joins it.
    expect(rows[2].edges).toContainEqual({ from: 1, to: 1, color: 1, half: 'bottom' })
    expect(rows[3].edges.filter(edge => edge.half === 'bottom')).toEqual([])
  })

  it('handles octopus merges, lane reuse and parents outside the history window', () => {
    const { rows, laneCount } = buildCommitGraph([
      commit('merge', ['a', 'b', 'c']), commit('b', []), commit('c', []), commit('a', ['older']),
    ])
    expect(laneCount).toBe(3)
    expect(rows[0].edges.filter(edge => edge.half === 'bottom')).toHaveLength(3)
    expect(rows[3].edges).toContainEqual({ from: 0, to: 0, color: 0, half: 'bottom' })
    const disconnected = buildCommitGraph([commit('a', []), commit('b', [])])
    expect(disconnected.laneCount).toBe(1)
    expect(disconnected.rows.every(row => row.edges.length === 0)).toBe(true)
  })

  it('does not invent ancestry for older server responses', () => {
    expect(buildCommitGraph([commit('a'), commit('b')]).rows.every(row => row.edges.length === 0)).toBe(true)
  })

  it('renders accessible commit rows, escaped text and an empty state', () => {
    expect(renderToStaticMarkup(React.createElement(CommitGraph, { commits: [] }))).toContain('No commits available.')
    const html = renderToStaticMarkup(<CommitGraph commits={[
      { ...commit('merge', ['a', 'b']), subject: '<script>message</script>', decorations: '(HEAD -> main)' },
    ]} />)
    expect(html).toContain('role="list"')
    expect(html).toContain('role="listitem"')
    expect(html).toContain('HEAD -&gt; main')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<path')
    expect(html.match(/<circle/g)).toHaveLength(2)
  })
})
