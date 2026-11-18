import type { AgentsPillSize } from '../../features/ui/runningAgentsUiSlice'

export interface PillSpace { right: number; bottom: number; top?: number }

export function getAgentsPillLimits(space: PillSpace): AgentsPillSize {
  return {
    width: Math.max(1, space.right - 12),
    height: Math.max(1, space.bottom - (space.top ?? 0) - 12),
  }
}

export function clampAgentsPillSize(size: AgentsPillSize, space: PillSpace): AgentsPillSize {
  const { width: maxWidth, height: maxHeight } = getAgentsPillLimits(space)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(320, maxWidth), size.width)),
    height: Math.min(maxHeight, Math.max(Math.min(240, maxHeight), size.height)),
  }
}

/** Bottom/right stay anchored: moving the top-left handle left/up grows the shell. */
export function resizeAgentsPillFromCorner(start: AgentsPillSize, dx: number, dy: number, space: PillSpace): AgentsPillSize {
  return clampAgentsPillSize({ width: start.width - dx, height: start.height - dy }, space)
}
