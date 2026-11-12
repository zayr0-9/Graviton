import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ states: [] as any[], refs: [] as any[], si: 0, ri: 0, ei: 0, effects: [] as { deps: unknown[]; cleanup?: () => void }[], cleanup: undefined as (() => void) | undefined }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: any) => {
    const index = host.si++
    if (!(index in host.states)) host.states[index] = initial
    return [host.states[index], (value: any) => { host.states[index] = value }]
  },
  useRef: (initial: any) => host.refs[host.ri++] ??= { current: initial },
  useLayoutEffect: (effect: () => () => void, deps: unknown[]) => {
    const index = host.ei++
    const previous = host.effects[index]
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      previous?.cleanup?.(); host.effects[index] = { deps, cleanup: effect() }
    }
    host.cleanup = () => host.effects.forEach(item => item.cleanup?.())
  },
}))
import { ResizableMessagePreview } from './ResizableMessagePreview'

let props: Parameters<typeof ResizableMessagePreview>[0]
let handle: any
let escape: (event: any) => void
const render = () => { host.si = 0; host.ri = 0; host.ei = 0; return ResizableMessagePreview(props) }
const edge = (index: number) => render().props.children.props.children[1][index].props
const pointer = (x: number, y = 100, pointerId = 1) => ({ clientX: x, clientY: y, pointerId, button: 0, isPrimary: true, currentTarget: handle, preventDefault: vi.fn(), stopPropagation: vi.fn() })
const key = (key: string, shiftKey = false) => ({ key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() })

beforeEach(() => {
  host.states = []; host.refs = []; host.si = 0; host.ri = 0; host.effects = []; host.ei = 0; host.cleanup = undefined
  handle = { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn(), blur: vi.fn(), getBoundingClientRect: () => ({ left: 325, right: 333, top: 116, bottom: 284 }) }
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('document', { activeElement: null })
  vi.stubGlobal('window', { addEventListener: vi.fn((_name, callback) => { escape = callback }), removeEventListener: vi.fn() })
  props = {
    previewKey: 'message-1', layout: { left: 12, top: 100, width: 320, maxHeight: 450 }, dimensions: { width: 1000, height: 800 },
    containerRef: { current: { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) } as any },
    cardRef: { current: { getBoundingClientRect: () => ({ left: 12, top: 100, width: 320, height: 200, right: 332, bottom: 300 }), contains: () => false, matches: () => false } as any },
    preferredRef: { current: null }, draggingRef: { current: false }, accent: 'red', onEnter: vi.fn(), onLeave: vi.fn(), children: <p>Message</p>,
  }
})
afterEach(() => { host.cleanup?.(); vi.unstubAllGlobals() })

describe('message preview resizing', () => {
  it('renders four accessible edge targets without a corner grip', () => {
    const html = renderToStaticMarkup(render())
    expect(html.match(/aria-label="Resize message preview/g)).toHaveLength(4)
    expect(html).toContain('data-heimdall-wheel-exempt="true"')
    expect(html).toContain('cursor-ew-resize')
    expect(html).toContain('cursor-ns-resize')
    expect(html).not.toContain('resize:')
  })

  it('measures actual height and applies release coordinates before a frame paints', () => {
    const right = edge(1)
    right.onPointerDown(pointer(332))
    expect(host.states[0].height).toBe(200)
    expect(props.draggingRef.current).toBe(true)
    right.onPointerMove(pointer(500))
    right.onPointerUp(pointer(700))
    expect(props.preferredRef.current).toEqual({ width: 688 })
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(props.draggingRef.current).toBe(false)
    expect(props.onLeave).toHaveBeenCalled()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  })

  it.each(['onPointerCancel', 'onLostPointerCapture'])('restores automatic sizing on %s', eventName => {
    const right = edge(1)
    right.onPointerDown(pointer(332)); right.onPointerMove(pointer(500)); right[eventName](pointer(500))
    expect(host.states[0]).toBeNull()
    expect(props.preferredRef.current).toBeNull()
    expect(props.draggingRef.current).toBe(false)
  })

  it('ignores secondary buttons and unrelated pointers', () => {
    const right = edge(1)
    right.onPointerDown({ ...pointer(332), button: 2 })
    expect(handle.setPointerCapture).not.toHaveBeenCalled()
    right.onPointerDown(pointer(332)); right.onPointerUp(pointer(600, 100, 2))
    expect(props.draggingRef.current).toBe(true)
    expect(props.preferredRef.current).toBeNull()
  })

  it('cancels on Escape and cleans up capture/frames on unmount', () => {
    const right = edge(1)
    right.onPointerDown(pointer(332)); right.onPointerMove(pointer(500)); escape(key('Escape'))
    expect(props.draggingRef.current).toBe(false)
    expect(host.states[0]).toBeNull()
    right.onPointerDown(pointer(332)); right.onPointerMove(pointer(500)); host.cleanup?.()
    expect(props.draggingRef.current).toBe(false)
    expect(handle.releasePointerCapture).toHaveBeenCalledTimes(2)
  })

  it('supports keyboard steps, reset, and preserves preferred size through panel changes', () => {
    edge(1).onKeyDown(key('ArrowRight', true))
    expect(props.preferredRef.current).toEqual({ width: 352 })
    props = { ...props, previewKey: 'message-2', dimensions: { width: 250, height: 180 } }
    render()
    const clamped = render().props.children.props.style
    expect(clamped.width).toBe(226)
    expect(clamped.height).toBeUndefined()
    expect(clamped.maxHeight).toBe(160)
    expect(props.preferredRef.current).toEqual({ width: 352 })
    props = { ...props, dimensions: { width: 1000, height: 800 } }
    render()
    expect(render().props.children.props.style.width).toBe(352)
    edge(1).onKeyDown(key('Home'))
    expect(props.preferredRef.current).toBeNull()
  })

  it('does not persist a click without movement and unpins pointer-focused handles', () => {
    const right = edge(1)
    right.onPointerDown(pointer(332)); right.onPointerUp(pointer(332))
    expect(props.preferredRef.current).toBeNull()
    expect(host.states[0]).toBeNull()
    vi.stubGlobal('document', { activeElement: handle })
    right.onPointerDown(pointer(332)); right.onPointerUp(pointer(500))
    expect(handle.blur).toHaveBeenCalledOnce()
  })

  it('retains manually moved position when panel dimensions change', () => {
    props.layout.left = 200
    props.cardRef.current!.getBoundingClientRect = () => ({ left: 200, top: 100, width: 320, height: 200, right: 520, bottom: 300 }) as DOMRect
    const left = edge(0)
    left.onPointerDown(pointer(200)); left.onPointerUp(pointer(100))
    props = { ...props, dimensions: { width: 900, height: 800 } }
    render()
    expect(render().props.style.left).toBe(100)
  })

  it('cancels a drag when the panel changes and retains focus on release', () => {
    const right = edge(1)
    right.onPointerDown(pointer(332)); right.onPointerMove(pointer(500))
    props = { ...props, dimensions: { width: 900, height: 800 } }
    render()
    expect(props.draggingRef.current).toBe(false)
    expect(props.preferredRef.current).toBeNull()
    expect(props.onLeave).toHaveBeenCalledOnce()
    vi.mocked(props.onLeave).mockClear()
    props.cardRef.current!.contains = () => true
    edge(1).onPointerDown(pointer(332)); edge(1).onPointerUp(pointer(500))
    expect(props.onEnter).toHaveBeenCalled()
    expect(props.onLeave).not.toHaveBeenCalled()
  })
})
