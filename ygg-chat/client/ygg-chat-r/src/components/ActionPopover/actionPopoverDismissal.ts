/** Use the original event path: animated labels can unmount during their click. */
export function isActionPopoverInsideClick(event: Event, trigger: EventTarget | null, popover: EventTarget | null) {
  return event.composedPath().some(node =>
    node === trigger || node === popover ||
    (node instanceof Element && ['select-dropdown', 'action-popover'].includes(node.getAttribute('data-ygg-overlay') ?? ''))
  )
}
