/**
 * Pure helpers for `DisclosurePanel` (messagePrimitives.tsx). Kept out of the component file so
 * fast refresh treats that file as components only.
 */

/** Longest `.tool-expand-container` transition (260ms) plus slack, for a `transitionend` that never arrives. */
export const COLLAPSE_UNMOUNT_FALLBACK_MS = 400

/**
 * Whether `event` is the panel's own height transition ending. `transitionend` bubbles, so the
 * content opacity fade and the chevron rotation reach the container too and must not count.
 */
export const isPanelCollapseTransitionEnd = (event: {
  target: EventTarget | null
  currentTarget: EventTarget | null
  propertyName: string
}): boolean => event.target === event.currentTarget && event.propertyName === 'grid-template-rows'

/**
 * Whether a panel keeps its children in the tree for this render. Children mount on the render
 * that opens the panel, so the height transition starts from the real content size. On close they
 * stay until the transition ends. Without a transition (streaming rows set `transition: none`)
 * no `transitionend` fires, so they unmount at once.
 */
export const resolvePanelChildrenMounted = (expanded: boolean, mounted: boolean, disableTransition: boolean): boolean => {
  if (expanded) return true
  if (disableTransition) return false
  return mounted
}
