import React, { useMemo } from 'react'
import type { LocalGitCommit } from '../../../shared/localGit'
import { buildCommitGraph, GRAPH_COLORS, GRAPH_LANE_WIDTH, GRAPH_PADDING, GRAPH_ROW_HEIGHT } from './commitGraphLayout'

export function CommitGraph({ commits }: { commits: LocalGitCommit[] }): React.ReactElement {
  const { rows, laneCount } = useMemo(() => buildCommitGraph(commits), [commits])
  const width = GRAPH_PADDING * 2 + laneCount * GRAPH_LANE_WIDTH
  const x = (lane: number) => GRAPH_PADDING + lane * GRAPH_LANE_WIDTH
  const color = (index: number) => GRAPH_COLORS[index % GRAPH_COLORS.length]
  const mid = GRAPH_ROW_HEIGHT / 2

  if (!rows.length) {
    return <div className='py-2 text-xs text-neutral-500 dark:text-neutral-400'>No commits available.</div>
  }

  return (
    <div className='max-h-96 overflow-auto rounded-lg border border-neutral-200/70 bg-white/60 dark:border-neutral-800/70 dark:bg-neutral-950/40' aria-label='Commit history' role='list'>
      {rows.map(({ commit, lane, color: nodeColor, edges }) => (
        <div
          key={commit.hash}
          role='listitem'
          tabIndex={0}
          title={`${commit.subject}\n${commit.author} • ${commit.relativeDate}\n${commit.hash}${commit.decorations ? `\n${commit.decorations}` : ''}`}
          className='flex min-w-0 items-center pr-3 text-xs text-neutral-800 outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500 dark:text-neutral-200 dark:hover:bg-white/5 dark:focus-visible:bg-white/5'
          style={{ height: GRAPH_ROW_HEIGHT }}
        >
          <svg width={width} height={GRAPH_ROW_HEIGHT} className='shrink-0' aria-hidden='true'>
            {edges.map((edge, index) => {
              const startY = edge.half === 'top' ? 0 : mid
              const endY = edge.half === 'top' ? mid : GRAPH_ROW_HEIGHT
              const controlY = (startY + endY) / 2
              return <path key={index} d={`M ${x(edge.from)} ${startY} C ${x(edge.from)} ${controlY}, ${x(edge.to)} ${controlY}, ${x(edge.to)} ${endY}`} fill='none' stroke={color(edge.color)} strokeWidth={1.5} />
            })}
            <circle cx={x(lane)} cy={mid} r={commit.parents && commit.parents.length > 1 ? 5 : 4} fill={color(nodeColor)} />
            {commit.parents && commit.parents.length > 1 && (
              <circle cx={x(lane)} cy={mid} r={2.5} className='fill-white dark:fill-neutral-950' />
            )}
          </svg>
          <div className='flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap'>
            <span className='truncate'>{commit.subject || '(no commit message)'}</span>
            <span className='shrink-0 text-neutral-500 dark:text-neutral-400'>{commit.author}</span>
            {commit.decorations && <span className='shrink-0 rounded border border-neutral-300 px-1 text-[10px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'>{commit.decorations.replace(/^\s*\(|\)\s*$/g, '')}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
