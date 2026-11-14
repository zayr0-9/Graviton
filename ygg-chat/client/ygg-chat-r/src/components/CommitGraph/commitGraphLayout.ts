import type { LocalGitCommit } from '../../../shared/localGit'

export const GRAPH_ROW_HEIGHT = 28
export const GRAPH_LANE_WIDTH = 16
export const GRAPH_PADDING = 12
export const GRAPH_COLORS = ['#e87500', '#df238b', '#36ada5', '#b16aee', '#e9aa00', '#458bea']

type Lane = { hash: string; color: number }
export type GraphEdge = { from: number; to: number; color: number; half: 'top' | 'bottom' }
export type GraphRow = { commit: LocalGitCommit; lane: number; color: number; edges: GraphEdge[] }

/** Input is newest-first topological order. Empty slots keep unrelated lanes stationary. */
export function buildCommitGraph(commits: LocalGitCommit[]): { rows: GraphRow[]; laneCount: number } {
  const lanes: Array<Lane | null> = []
  let nextColor = 0
  let laneCount = 1
  const rows = commits.map(commit => {
    let lane = lanes.findIndex(entry => entry?.hash === commit.hash)
    if (lane < 0) {
      lane = lanes.findIndex(entry => entry === null)
      if (lane < 0) lane = lanes.length
      lanes[lane] = { hash: commit.hash, color: nextColor++ }
    }
    const color = lanes[lane]!.color
    const edges: GraphEdge[] = []
    lanes.forEach((entry, index) => {
      if (!entry) return
      // New/disconnected tips have no incoming line.
      if (index !== lane) edges.push({ from: index, to: index, color: entry.color, half: 'top' })
    })
    const continuingLanes = lanes.map((entry, index) => index !== lane ? entry : null)
    lanes[lane] = null
    const parents = [...new Set(commit.parents || [])]
    parents.forEach((hash, index) => {
      let target = lanes.findIndex(entry => entry?.hash === hash)
      if (target < 0) {
        target = index === 0 ? lane : lanes.findIndex(entry => entry === null)
        if (target < 0) target = lanes.length
        lanes[target] = { hash, color: index === 0 ? color : nextColor++ }
      }
      edges.push({ from: lane, to: target, color: lanes[target]!.color, half: 'bottom' })
    })
    continuingLanes.forEach((entry, index) => {
      if (entry) {
        edges.push({ from: index, to: index, color: entry.color, half: 'bottom' })
      }
    })
    laneCount = Math.max(laneCount, lanes.length)
    return { commit, lane, color, edges }
  })
  // Each outgoing edge continues to the next row's midpoint, including curves into a merge target.
  rows.forEach((row, index) => {
    const next = rows[index + 1]
    if (!next) return
    row.edges.filter(edge => edge.half === 'bottom').forEach(edge => {
      if (edge.to === next.lane && !next.edges.some(e => e.half === 'top' && e.from === edge.to)) {
        next.edges.push({ from: edge.to, to: edge.to, color: edge.color, half: 'top' })
      }
    })
  })
  return { rows, laneCount }
}
