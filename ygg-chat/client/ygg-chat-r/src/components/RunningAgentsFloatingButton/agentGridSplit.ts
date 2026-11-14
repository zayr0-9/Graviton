/** Keep the existing responsive 18rem card target and three-column cap. */
export function getAgentGridColumns(width: number, viewportWidth: number, rem: number, count: number): number {
  const cap = viewportWidth >= 1280 ? 3 : viewportWidth >= 768 ? 2 : 1
  return Math.max(1, Math.min(count, cap, Math.floor((width + 0.75 * rem) / (18.75 * rem))))
}

/** Ratios describe card space only; gutters are excluded from availableWidth. */
export function resizeAgentGridSplit(ratios: number[], divider: number, delta: number, availableWidth: number, minimumWidth = 160): number[] {
  if (divider < 0 || divider >= ratios.length - 1 || availableWidth <= 0) return ratios
  const next = [...ratios]
  const pair = ratios[divider] + ratios[divider + 1]
  // A narrow container must still fit, even when it cannot honor the usual minimum.
  const minimum = Math.min(minimumWidth / availableWidth, pair / 2)
  next[divider] = Math.max(minimum, Math.min(pair - minimum, ratios[divider] + delta / availableWidth))
  next[divider + 1] = pair - next[divider]
  return next
}

/** Fixed strip width for a user-collapsed card. */
export const COLLAPSED_AGENT_CARD_TRACK = '3rem'

/**
 * Sub-1fr tracks can leave free space after a neighboring track hits its minimum.
 * Collapsed cells take a fixed strip; open cells share the rest by their own ratios.
 */
export function getAgentGridTracks(ratios: number[], collapsed: readonly boolean[] = []): string {
  const open = ratios.filter((_, index) => !collapsed[index])
  const smallest = Math.min(...open)
  return ratios.map((ratio, index) => collapsed[index]
    ? COLLAPSED_AGENT_CARD_TRACK
    : `minmax(min(160px, 100%), ${ratio / smallest}fr)`).join(' ')
}
