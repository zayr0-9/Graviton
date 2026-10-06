import type { AgentsPillSize } from '../../features/ui/runningAgentsUiSlice'

export interface PillSpace { right: number; bottom: number }
export function clampAgentsPillSize(size: AgentsPillSize, space: PillSpace): AgentsPillSize {
  const maxWidth = Math.max(1, space.right - 12)
  const maxHeight = Math.max(1, space.bottom - 12)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(320, maxWidth), size.width)),
    height: Math.min(maxHeight, Math.max(Math.min(240, maxHeight), size.height)),
  }
}

/** Bottom/right stay anchored: moving the top-left handle left/up grows the shell. */
export function resizeAgentsPillFromCorner(start: AgentsPillSize, dx: number, dy: number, space: PillSpace): AgentsPillSize {
  return clampAgentsPillSize({ width: start.width - dx, height: start.height - dy }, space)
}
