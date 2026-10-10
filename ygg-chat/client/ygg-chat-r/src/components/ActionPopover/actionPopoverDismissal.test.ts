import { afterEach, describe, expect, it, vi } from 'vitest'
import { isActionPopoverInsideClick } from './actionPopoverDismissal'

// Node renderer tests need only the Element contract used by dismissal.
class TestElement extends EventTarget {
  constructor(private overlay: string | null = null) { super() }
  getAttribute(name: string) { return name === 'data-ygg-overlay' ? this.overlay : null }
}
function click(path: EventTarget[]) {
  return { composedPath: () => path } as unknown as Event
}
afterEach(() => vi.unstubAllGlobals())

describe('ActionPopover click dismissal', () => {
  it('keeps clicks on animated content inside even after the target is detached', () => {
    vi.stubGlobal('Element', TestElement)
    const shell = new TestElement(), detachedLabel = new TestElement()
    expect(isActionPopoverInsideClick(click([detachedLabel, shell]), null, shell)).toBe(true)
  })
  it('keeps trigger clicks inside for the explicit toggle handler', () => {
    vi.stubGlobal('Element', TestElement)
    const trigger = new TestElement()
    expect(isActionPopoverInsideClick(click([trigger]), trigger, null)).toBe(true)
  })
  it('keeps custom dropdown portal clicks inside, even if selection removes the portal', () => {
    vi.stubGlobal('Element', TestElement)
    expect(isActionPopoverInsideClick(click([new TestElement(), new TestElement('select-dropdown')]), null, new TestElement())).toBe(true)
  })
  it('recognizes the shell and padding even when its animation ref is unavailable', () => {
    vi.stubGlobal('Element', TestElement)
    expect(isActionPopoverInsideClick(click([new TestElement('action-popover')]), null, null)).toBe(true)
  })
  it('dismisses genuine outside clicks', () => {
    vi.stubGlobal('Element', TestElement)
    expect(isActionPopoverInsideClick(click([new TestElement()]), new TestElement(), new TestElement())).toBe(false)
  })
})
