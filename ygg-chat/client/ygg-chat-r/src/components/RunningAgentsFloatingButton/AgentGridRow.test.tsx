import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A tiny hook host lets pointer-capture handlers run in the node renderer suite.
const host = vi.hoisted(() => ({ states: [] as any[], refs: [] as any[], stateIndex: 0, refIndex: 0, cleanup: undefined as (() => void) | undefined }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: any) => {
    const index = host.stateIndex++
    if (!(index in host.states)) host.states[index] = typeof initial === 'function' ? initial() : initial
    return [host.states[index], (value: any) => { host.states[index] = typeof value === 'function' ? value(host.states[index]) : value }]
  },
  useRef: (initial: any) => {
    const index = host.refIndex++
    return host.refs[index] ??= { current: initial }
  },
  useLayoutEffect: (effect: () => () => void) => { host.cleanup = effect() },
}))
import { AgentGridRow } from './AgentGridRow'

const render = () => {
  host.stateIndex = 0
  host.refIndex = 0
  return AgentGridRow({ label: 'Agent row 1', children: [<section key='a'>A</section>, <section key='b'>B</section>, <section key='c'>C</section>] })
}
const separator = (tree: ReturnType<typeof render>, index = 0) => tree.props.children[index].props.children[1]
let width = 1024
let handle: { focus: ReturnType<typeof vi.fn>; setPointerCapture: ReturnType<typeof vi.fn>; hasPointerCapture: ReturnType<typeof vi.fn>; releasePointerCapture: ReturnType<typeof vi.fn> }
const pointer = (x: number, pointerId = 1) => ({ clientX: x, pointerId, button: 0, isPrimary: true, currentTarget: handle, preventDefault: vi.fn(), stopPropagation: vi.fn() })
const key = (value: string, shiftKey = false) => ({ key: value, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() })

beforeEach(() => {
  host.states = []; host.refs = []; host.cleanup = undefined
  width = 1024
  handle = { focus: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() }
  vi.stubGlobal('getComputedStyle', () => ({ columnGap: '12px' }))
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

const setup = () => {
  const tree = render()
  host.refs[0].current = {
    getBoundingClientRect: () => ({ width }),
    children: [0, 1, 2].map(index => ({ getBoundingClientRect: () => ({ width: host.states[0][index] * (width - 24) }) })),
  }
  return separator(tree).props
}

describe('agent row splitters', () => {
  it('places accessible full-height drag targets in the empty gutters', () => {
    const html = renderToStaticMarkup(render())
    expect(html.match(/role="separator"/g)).toHaveLength(2)
    expect(html).toContain('aria-orientation="vertical"')
    expect(html).toContain('Agent row 1: resize cells 1 and 2')
    expect(html).toContain('cursor-col-resize')
    expect(html).toContain('touch-none')
  })

  it('renders full-width tracks after dragging a three-cell row to its minimum', () => {
    const props = setup()
    props.onPointerDown(pointer(100)); props.onPointerUp(pointer(-9999))
    const tracks = render().props.style.gridTemplateColumns
    const factors = [...tracks.matchAll(/([\d.]+)fr/g)].map(match => Number(match[1]))
    expect(Math.min(...factors)).toBe(1)
    expect(factors.every(factor => factor >= 1)).toBe(true)
  })

  it('captures the pointer and applies the final drag position even before a frame paints', () => {
    const props = setup()
    props.onPointerDown(pointer(100))
    props.onPointerMove(pointer(200))
    props.onPointerUp(pointer(200))
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(host.states[0][0]).toBeCloseTo(1 / 3 + 0.1)
    expect(host.states[0][1]).toBeCloseTo(1 / 3 - 0.1)
    expect(host.states[0][2]).toBeCloseTo(1 / 3)
  })

  it('uses release coordinates even when no final pointermove arrives', () => {
    const props = setup()
    props.onPointerDown(pointer(100)); props.onPointerMove(pointer(150)); props.onPointerUp(pointer(200))
    expect(host.states[0][0]).toBeCloseTo(1 / 3 + 0.1)
  })

  it('resets row geometry when membership changes without changing surviving wrapper keys', () => {
    const before = render()
    host.states[0] = [0.2, 0.3, 0.5]
    host.stateIndex = 0; host.refIndex = 0
    const after = AgentGridRow({ label: 'Agent row 1', children: [<section key='a'>A</section>, <section key='b'>B</section>] })
    expect(host.states[0]).toEqual([0.5, 0.5])
    expect(after.props.children[0].key).toBe(before.props.children[0].key)
  })

  it.each(['onPointerCancel', 'onLostPointerCapture'])('restores initial ratios on %s', eventName => {
    const props = setup()
    props.onPointerDown(pointer(100)); props.onPointerMove(pointer(200)); props[eventName](pointer(200))
    expect(host.states[0]).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  it('ignores other pointers and secondary buttons', () => {
    const props = setup()
    props.onPointerDown({ ...pointer(100), button: 2 })
    expect(handle.setPointerCapture).not.toHaveBeenCalled()
    props.onPointerDown(pointer(100)); props.onPointerMove(pointer(200, 2)); props.onPointerUp(pointer(200, 2))
    expect(host.states[0]).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(handle.releasePointerCapture).not.toHaveBeenCalled()
  })

  it('supports arrows, larger Shift steps, and row reset', () => {
    setup().onKeyDown(key('ArrowRight'))
    expect(host.states[0][0]).toBeCloseTo(1 / 3 + 0.008)
    separator(render(), 1).props.onKeyDown(key('ArrowLeft', true))
    expect(host.states[0][2]).toBeCloseTo(1 / 3 + 0.032)
    separator(render()).props.onKeyDown(key('Home'))
    expect(host.states[0]).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  it('cancels stale drag geometry after a container resize', () => {
    const props = setup()
    props.onPointerDown(pointer(100)); width = 800; props.onPointerMove(pointer(200))
    expect(host.states[0]).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(handle.releasePointerCapture).toHaveBeenCalled()
  })

  it('releases pointer capture and pending frames on unmount', () => {
    const props = setup()
    props.onPointerDown(pointer(100)); props.onPointerMove(pointer(200)); host.cleanup?.()
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  })
})
