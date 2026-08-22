import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './ui'
import type { MobileMessageTreeNode } from '../types'

interface PositionedNode {
  id: string
  sender: string
  message: string
  childCount: number
  x: number
  y: number
}

interface PositionedEdge {
  fromId: string
  toId: string
}

interface TreeLayout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  width: number
  height: number
}

interface MessageTreeDrawerProps {
  open: boolean
  tree: MobileMessageTreeNode | null
  activePathIds: string[]
  activeTipId?: string | null
  hideEmptyAssistantMessages: boolean
  onToggleHideEmptyAssistantMessages: () => void
  onSelectMessage: (messageId: string) => void
  onClose: () => void
}

const NODE_WIDTH = 180
const NODE_HEIGHT = 58
const H_SPACING = 220
const V_SPACING = 92
const PAD_X = 28
const PAD_Y = 20
const MIN_ZOOM = 0.35
const MAX_ZOOM = 3

const roleLabel = (sender: string) => {
  if (sender === 'user') return 'You'
  if (sender === 'assistant') return 'AI'
  if (sender === 'tool') return 'Tool'
  if (sender === 'ex_agent') return 'Agent'
  return 'System'
}

const normalizeRoots = (tree: MobileMessageTreeNode | null): MobileMessageTreeNode[] => {
  if (!tree) return []
  if (String(tree.id) === 'root') {
    return Array.isArray(tree.children) ? tree.children : []
  }
  return [tree]
}

const getChildrenInDisplayOrder = (children: MobileMessageTreeNode[] | undefined): MobileMessageTreeNode[] => {
  // Keep backend-provided sibling order (children_ids sequence) so mobile matches desktop
  // branch ordering semantics (latest branch appears on the same side as desktop).
  return Array.isArray(children) ? [...children] : []
}

const getPreviewLines = (message: string): [string, string] => {
  const text = (message || '').replace(/\s+/g, ' ').trim() || '(empty)'
  const first = text.slice(0, 34)
  const second = text.slice(34, 68)
  return [first, second]
}

const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value))

const buildTreeLayout = (tree: MobileMessageTreeNode | null): TreeLayout => {
  const roots = normalizeRoots(tree)
  if (!roots.length) {
    return {
      nodes: [],
      edges: [],
      width: 320,
      height: 160,
    }
  }

  const widthCache = new Map<string, number>()

  const subtreeWidth = (node: MobileMessageTreeNode): number => {
    const id = String(node.id)
    if (widthCache.has(id)) return widthCache.get(id) as number

    const children = getChildrenInDisplayOrder(node.children)
    const width = children.length === 0 ? 1 : children.reduce((sum, child) => sum + subtreeWidth(child), 0)
    widthCache.set(id, width)
    return width
  }

  roots.forEach(root => subtreeWidth(root))

  const nodes: PositionedNode[] = []
  const edges: PositionedEdge[] = []

  const placeNode = (node: MobileMessageTreeNode, centerXUnit: number, depth: number): void => {
    const children = getChildrenInDisplayOrder(node.children)

    nodes.push({
      id: String(node.id),
      sender: String(node.sender || 'assistant'),
      message: typeof node.message === 'string' ? node.message : '',
      childCount: children.length,
      x: centerXUnit * H_SPACING + PAD_X,
      y: depth * V_SPACING + PAD_Y,
    })

    if (!children.length) return

    const totalWidth = children.reduce((sum, child) => sum + subtreeWidth(child), 0)
    let cursor = centerXUnit - totalWidth / 2

    children.forEach(child => {
      const childWidth = subtreeWidth(child)
      const childCenter = cursor + childWidth / 2
      edges.push({ fromId: String(node.id), toId: String(child.id) })
      placeNode(child, childCenter, depth + 1)
      cursor += childWidth
    })
  }

  let forestCursor = 0
  roots.forEach(root => {
    const rootWidth = subtreeWidth(root)
    const center = forestCursor + rootWidth / 2
    placeNode(root, center, 0)
    forestCursor += rootWidth + 0.8
  })

  const maxX = nodes.reduce((max, node) => Math.max(max, node.x), 0)
  const maxY = nodes.reduce((max, node) => Math.max(max, node.y), 0)

  return {
    nodes,
    edges,
    width: Math.max(340, maxX + NODE_WIDTH / 2 + PAD_X),
    height: Math.max(180, maxY + NODE_HEIGHT + PAD_Y),
  }
}

export const MessageTreeDrawer: React.FC<MessageTreeDrawerProps> = ({
  open,
  tree,
  activePathIds,
  activeTipId = null,
  hideEmptyAssistantMessages,
  onToggleHideEmptyAssistantMessages,
  onSelectMessage,
  onClose,
}) => {
  const layout = useMemo(() => buildTreeLayout(tree), [tree])
  const activePathSet = useMemo(() => new Set(activePathIds.map(id => String(id))), [activePathIds])
  const nodeById = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout.nodes])

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)

  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  const hasAutoFittedRef = useRef(false)
  const lastTreeSignatureRef = useRef('')
  const pointerMapRef = useRef<Map<number, { x: number; y: number; pointerType: string }>>(new Map())
  const pinchStateRef = useRef<{ distance: number; zoom: number } | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    pointerType: string
    offsetX: number
    offsetY: number
    startX: number
    startY: number
  } | null>(null)
  const movedDuringInteractionRef = useRef(false)
  const suppressNextClickRef = useRef(false)

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    panRef.current = pan
  }, [pan])

  const treeSignature = useMemo(() => layout.nodes.map(node => node.id).join('|'), [layout.nodes])

  useEffect(() => {
    if (treeSignature === lastTreeSignatureRef.current) return
    lastTreeSignatureRef.current = treeSignature
    hasAutoFittedRef.current = false
  }, [treeSignature])

  const updateViewport = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    setViewport({ width: canvas.clientWidth, height: canvas.clientHeight })
  }, [])

  useEffect(() => {
    if (!open) return
    updateViewport()
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [open, updateViewport])

  const zoomAtClientPoint = useCallback((clientX: number, clientY: number, desiredZoom: number) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const localX = clientX - rect.left
    const localY = clientY - rect.top

    const currentZoom = zoomRef.current
    const currentPan = panRef.current
    const clampedZoom = clampZoom(desiredZoom)

    const contentX = (localX - currentPan.x) / currentZoom
    const contentY = (localY - currentPan.y) / currentZoom

    const nextPan = {
      x: localX - contentX * clampedZoom,
      y: localY - contentY * clampedZoom,
    }

    zoomRef.current = clampedZoom
    panRef.current = nextPan
    setZoom(clampedZoom)
    setPan(nextPan)
  }, [])

  const fitToView = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const width = canvas.clientWidth || 1
    const height = canvas.clientHeight || 1

    const fitZoom = Math.min((width - 28) / Math.max(layout.width, 1), (height - 28) / Math.max(layout.height, 1), 1)
    const nextZoom = clampZoom(Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1)

    const nextPan = {
      x: (width - layout.width * nextZoom) / 2,
      y: (height - layout.height * nextZoom) / 2,
    }

    zoomRef.current = nextZoom
    panRef.current = nextPan
    hasAutoFittedRef.current = true
    setZoom(nextZoom)
    setPan(nextPan)
  }, [layout.height, layout.width])

  useEffect(() => {
    if (!open) return
    const id = window.requestAnimationFrame(() => {
      updateViewport()
      if (!hasAutoFittedRef.current) {
        fitToView()
      }
    })

    return () => {
      window.cancelAnimationFrame(id)
    }
  }, [open, fitToView, updateViewport])

  const startPinchIfNeeded = useCallback(() => {
    const touchPointers = Array.from(pointerMapRef.current.values()).filter(pointer => pointer.pointerType === 'touch')
    if (touchPointers.length < 2) return

    const [first, second] = touchPointers
    const distance = Math.hypot(second.x - first.x, second.y - first.y)
    if (!distance) return

    pinchStateRef.current = {
      distance,
      zoom: zoomRef.current,
    }
    dragStateRef.current = null
    setIsDragging(false)
  }, [])

  const handlePointerDown: React.PointerEventHandler<HTMLDivElement> = event => {
    if (!open) return

    movedDuringInteractionRef.current = false

    pointerMapRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    })

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // no-op
    }

    startPinchIfNeeded()

    if (pinchStateRef.current) {
      suppressNextClickRef.current = true
      return
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      offsetX: event.clientX - panRef.current.x,
      offsetY: event.clientY - panRef.current.y,
      startX: event.clientX,
      startY: event.clientY,
    }
  }

  const handlePointerMove: React.PointerEventHandler<HTMLDivElement> = event => {
    if (!pointerMapRef.current.has(event.pointerId)) return

    pointerMapRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    })

    const touchPointers = Array.from(pointerMapRef.current.values()).filter(pointer => pointer.pointerType === 'touch')
    if (touchPointers.length >= 2) {
      if (!pinchStateRef.current) {
        startPinchIfNeeded()
      }

      const pinchState = pinchStateRef.current
      if (!pinchState) return

      const [first, second] = touchPointers
      const distance = Math.hypot(second.x - first.x, second.y - first.y)
      if (!distance) return

      const midpointX = (first.x + second.x) / 2
      const midpointY = (first.y + second.y) / 2
      const nextZoom = pinchState.zoom * (distance / pinchState.distance)

      movedDuringInteractionRef.current = true
      suppressNextClickRef.current = true
      zoomAtClientPoint(midpointX, midpointY, nextZoom)
      return
    }

    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) return

    const nextPan = {
      x: event.clientX - dragState.offsetX,
      y: event.clientY - dragState.offsetY,
    }

    const tapSlop = dragState.pointerType === 'touch' ? 10 : 3
    const pointerTravel = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY)
    const movedEnough = pointerTravel > tapSlop

    if (movedEnough) {
      movedDuringInteractionRef.current = true
      suppressNextClickRef.current = true
      setIsDragging(true)
    }

    panRef.current = nextPan
    setPan(nextPan)
  }

  const clearPointer = useCallback((pointerId: number) => {
    pointerMapRef.current.delete(pointerId)

    const touchPointers = Array.from(pointerMapRef.current.values()).filter(pointer => pointer.pointerType === 'touch')
    if (touchPointers.length < 2) {
      pinchStateRef.current = null
    }

    if (dragStateRef.current?.pointerId === pointerId) {
      dragStateRef.current = null
    }

    if (movedDuringInteractionRef.current) {
      window.setTimeout(() => {
        suppressNextClickRef.current = false
      }, 0)
    } else if (pointerMapRef.current.size === 0) {
      suppressNextClickRef.current = false
    }

    movedDuringInteractionRef.current = false
    setIsDragging(false)
  }, [])

  const handlePointerUp: React.PointerEventHandler<HTMLDivElement> = event => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // no-op
    }
    clearPointer(event.pointerId)
  }

  const handlePointerCancel: React.PointerEventHandler<HTMLDivElement> = event => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // no-op
    }
    clearPointer(event.pointerId)
  }

  const handleWheel: React.WheelEventHandler<HTMLDivElement> = event => {
    event.preventDefault()
    const scale = Math.exp(-event.deltaY * 0.001)
    zoomAtClientPoint(event.clientX, event.clientY, zoomRef.current * scale)
  }

  const handleZoomStep = (factor: number) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    zoomAtClientPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, zoomRef.current * factor)
  }

  const handleNodeClick = (messageId: string) => {
    if (suppressNextClickRef.current) return
    onSelectMessage(messageId)
    onClose()
  }

  return (
    <>
      <div
        className={`mobile-tree-drawer-backdrop${open ? ' open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />

      <section className={`mobile-tree-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
        <header className='mobile-tree-drawer-header'>
          <div className='mobile-tree-drawer-grabber' />
          <div className='mobile-tree-drawer-title-row'>
            <strong>Chat Tree</strong>
            <Button onClick={onClose} variant='outline' size='sm'>
              Close
            </Button>
          </div>
        </header>

        <div className='mobile-tree-drawer-body'>
          {!layout.nodes.length ? <div className='mobile-tree-empty'>No tree nodes yet.</div> : null}

          {layout.nodes.length ? (
            <>
              <div className='mobile-tree-canvas-toolbar'>
                <Button onClick={() => handleZoomStep(1.2)} variant='outline' size='sm'>
                  +
                </Button>
                <Button onClick={() => handleZoomStep(1 / 1.2)} variant='outline' size='sm'>
                  −
                </Button>
                <Button onClick={fitToView} variant='outline' size='sm'>
                  Fit
                </Button>
                <Button onClick={onToggleHideEmptyAssistantMessages} variant='outline' size='sm'>
                  {hideEmptyAssistantMessages ? 'Show Empty AI' : 'Hide Empty AI'}
                </Button>
                <span>Zoom {Math.round(zoom * 100)}%</span>
              </div>

              <div
                ref={canvasRef}
                className={`mobile-tree-drawer-canvas interactive${isDragging ? ' dragging' : ''}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onWheel={handleWheel}
              >
                <svg width={Math.max(1, viewport.width)} height={Math.max(1, viewport.height)}>
                  <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                    <g strokeLinecap='round' strokeLinejoin='round' fill='none'>
                      {layout.edges.map(edge => {
                        const from = nodeById.get(edge.fromId)
                        const to = nodeById.get(edge.toId)
                        if (!from || !to) return null

                        const isOnPath = activePathSet.has(edge.fromId) && activePathSet.has(edge.toId)
                        const fromX = from.x
                        const fromY = from.y + NODE_HEIGHT
                        const toX = to.x
                        const toY = to.y
                        const midY = fromY + (toY - fromY) * 0.45

                        const path = `M ${fromX} ${fromY} L ${fromX} ${midY} L ${toX} ${midY} L ${toX} ${toY}`

                        return (
                          <path
                            key={`${edge.fromId}-${edge.toId}`}
                            d={path}
                            className={isOnPath ? 'mobile-tree-edge active' : 'mobile-tree-edge'}
                          />
                        )
                      })}
                    </g>

                    {layout.nodes.map(node => {
                      const isActiveTip = activeTipId === node.id
                      const isOnActivePath = activePathSet.has(node.id)
                      const [line1, line2] = getPreviewLines(node.message)

                      return (
                        <g
                          key={node.id}
                          transform={`translate(${node.x - NODE_WIDTH / 2}, ${node.y})`}
                          className='mobile-tree-node-visual'
                          onClick={() => handleNodeClick(node.id)}
                        >
                          <rect
                            width={NODE_WIDTH}
                            height={NODE_HEIGHT}
                            rx='10'
                            className={`mobile-tree-node-rect${isActiveTip ? ' active-tip' : isOnActivePath ? ' active-path' : ''}`}
                          />

                          <text x='10' y='16' className='mobile-tree-node-role-text'>
                            {roleLabel(node.sender)}
                          </text>

                          <text x='10' y='34' className='mobile-tree-node-message-text'>
                            {line1}
                          </text>
                          <text x='10' y='49' className='mobile-tree-node-message-text'>
                            {line2}
                          </text>

                          {node.childCount > 1 ? (
                            <text x={NODE_WIDTH - 10} y='16' textAnchor='end' className='mobile-tree-node-branch-count-text'>
                              ×{node.childCount}
                            </text>
                          ) : null}
                        </g>
                      )
                    })}
                  </g>
                </svg>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </>
  )
}
