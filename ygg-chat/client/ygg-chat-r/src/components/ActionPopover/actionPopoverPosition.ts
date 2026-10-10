/** Anchor to the trigger, not the content height, so disclosures grow upward. */
export function getActionPopoverPosition(
  trigger: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'width'>,
  width: number,
  viewportWidth: number,
  viewportHeight: number
) {
  const padding = 8
  const above = Math.max(0, trigger.top - padding * 2)
  const below = Math.max(0, viewportHeight - trigger.bottom - padding * 2)
  // Prefer above; only use below for triggers near the top of the viewport.
  const opensAbove = above >= 240 || above >= below
  return {
    left: Math.max(padding, Math.min(trigger.left + trigger.width / 2 - width / 2, viewportWidth - width - padding)),
    top: opensAbove ? undefined : Math.max(padding, trigger.bottom + padding),
    bottom: opensAbove ? Math.max(padding, viewportHeight - trigger.top + padding) : undefined,
    maxHeight: Math.max(0, opensAbove ? above : below),
    measured: true,
  }
}
