import type { ChatNode } from '../../features/chats/chatTypes'
import type { HiddenTreeBoundary } from './heimdallTreeTraversal'

interface TreePosition {
  x: number
  y: number
  node: ChatNode
}

export interface CompactionDivider {
  key: string
  x1: number
  x2: number
  y: number
}

/** Geometry only: markers share the graph transform, but are culled independently of cards. */
export function buildCompactionDividers(
  boundaries: HiddenTreeBoundary[],
  positions: Record<string, TreePosition>,
  { compactMode, focusedNodeId, nodeWidth, nodeHeight, circleRadius, verticalSpacing }: {
    compactMode: boolean
    focusedNodeId: string | null
    nodeWidth: number
    nodeHeight: number
    circleRadius: number
    verticalSpacing: number
  }
): CompactionDivider[] {
  const dividers: CompactionDivider[] = []
  const syntheticRoot = positions.root
  const syntheticChildren = new Set(syntheticRoot?.node.children.map(child => child.id))
  for (let index = 0; index < boundaries.length; index++) {
    const boundary = boundaries[index]
    // A promoted forest gets a synthetic visible parent after filtering.
    const parent = boundary.parentId === null
      ? (boundary.childIds.some(id => syntheticChildren.has(id)) ? syntheticRoot : undefined)
      : positions[boundary.parentId]
    const parentBottom = parent
      ? parent.y + (!compactMode || parent.node.id === focusedNodeId ? nodeHeight : circleRadius * 2)
      : undefined
    for (const childId of boundary.childIds) {
      const child = positions[childId]
      if (!child) continue
      const gap = parentBottom === undefined ? verticalSpacing / 2 : child.y - parentBottom
      // A focused compact card can fill the entire gap. Do not draw over its edge.
      if (gap <= 2) continue
      const branching = parent && parent.node.children.length > 1
      const fraction = branching ? 0.8 : 0.5
      const y = parentBottom === undefined ? child.y - gap / 2 : parentBottom + gap * fraction
      const x = parent && !branching ? parent.x + (child.x - parent.x) * fraction : child.x
      // Compact branches are close together: keep their markers local, not card-wide.
      const halfWidth = compactMode ? circleRadius : nodeWidth / 2
      dividers.push({ key: `compaction-${index}-${childId}`, x1: x - halfWidth, x2: x + halfWidth, y })
    }
    // A completed tip has no child connector. Only mark an unambiguous leaf;
    // otherwise the marker would misleadingly cross a surviving sibling's trunk.
    if (boundary.childIds.length === 0 && parent && parent.node.children.length === 0 && parentBottom !== undefined) {
      const halfWidth = compactMode ? circleRadius : nodeWidth / 2
      dividers.push({ key: `compaction-${index}-tip`, x1: parent.x - halfWidth,
        x2: parent.x + halfWidth, y: parentBottom + Math.max(12, (verticalSpacing - (parentBottom - parent.y)) / 2) })
    }
  }
  return dividers
}
