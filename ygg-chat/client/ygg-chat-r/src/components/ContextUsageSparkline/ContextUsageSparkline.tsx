import { motion, useReducedMotion } from 'framer-motion'
import React, { useMemo } from 'react'

export interface ContextUsageSparklinePoint {
  usedTokens: number
  cachedInputTokens: number
}

interface ContextUsageSparklineProps {
  points: ContextUsageSparklinePoint[]
  totalColor: string
  isDarkMode: boolean
}

const WIDTH = 224
const HEIGHT = 54
const AXIS_WIDTH = 28
const PADDING_X = AXIS_WIDTH + 3
const PADDING_Y = 5
const MAX_POINTS = 16

const finiteTokenValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

const formatTokenAxisLabel = (value: number): string => {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`
  return `${Math.round(value)}`
}

const pointPath = (values: number[], maxValue: number): string => {
  const drawableWidth = WIDTH - PADDING_X * 2
  const drawableHeight = HEIGHT - PADDING_Y * 2

  return values
    .map((value, index) => {
      const x = PADDING_X + (index / Math.max(values.length - 1, 1)) * drawableWidth
      const y = PADDING_Y + drawableHeight - (value / maxValue) * drawableHeight
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

/** A small fixed-point SVG chart so each update can interpolate the line to its newest usage snapshot. */
export const ContextUsageSparkline: React.FC<ContextUsageSparklineProps> = ({ points, totalColor, isDarkMode }) => {
  const shouldReduceMotion = useReducedMotion()
  const chart = useMemo(() => {
    const recent = points.slice(-MAX_POINTS).map(point => ({
      usedTokens: finiteTokenValue(point.usedTokens),
      cachedInputTokens: finiteTokenValue(point.cachedInputTokens),
    }))
    const first = recent[0] || { usedTokens: 0, cachedInputTokens: 0 }
    const padded = [...Array(Math.max(0, MAX_POINTS - recent.length)).fill(first), ...recent]
    const maximum = Math.max(1, ...padded.flatMap(point => [point.usedTokens, point.cachedInputTokens]))
    const usedValues = padded.map(point => point.usedTokens)
    const cachedValues = padded.map(point => point.cachedInputTokens)

    const totalEnd = usedValues[usedValues.length - 1]
    const drawableHeight = HEIGHT - PADDING_Y * 2

    return {
      maximum,
      totalPath: pointPath(usedValues, maximum),
      cachedPath: pointPath(cachedValues, maximum),
      totalEndY: PADDING_Y + drawableHeight - (totalEnd / maximum) * drawableHeight,
    }
  }, [points])

  const cachedColor = isDarkMode ? 'rgba(212, 212, 216, 0.78)' : 'rgba(82, 82, 91, 0.65)'
  const transition = shouldReduceMotion ? { duration: 0 } : { type: 'spring' as const, stiffness: 150, damping: 25 }

  return (
    <div className='mt-2.5' aria-label='Context usage history chart'>
      <div className='mb-1.5 flex items-center justify-between gap-4 text-[10px] font-medium'>
        <span className='inline-flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300'>
          <span className='h-1.5 w-1.5 rounded-full' style={{ backgroundColor: totalColor }} />
          Total context
        </span>
        <span className='inline-flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400'>
          <span className='h-px w-2 border-t border-dashed' style={{ borderColor: cachedColor }} />
          Cached input
        </span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className='block h-[54px] w-56 overflow-visible' role='img'>
        <text
          x={AXIS_WIDTH - 2}
          y={PADDING_Y + 3}
          fill={isDarkMode ? 'rgba(212, 212, 216, 0.65)' : 'rgba(82, 82, 91, 0.6)'}
          fontSize='8'
          textAnchor='end'
        >
          {formatTokenAxisLabel(chart.maximum)}
        </text>
        <text
          x={AXIS_WIDTH - 2}
          y={HEIGHT - PADDING_Y}
          fill={isDarkMode ? 'rgba(212, 212, 216, 0.45)' : 'rgba(82, 82, 91, 0.45)'}
          fontSize='8'
          textAnchor='end'
        >
          0
        </text>
        <path
          d={`M ${PADDING_X - 1} ${PADDING_Y} L ${PADDING_X - 1} ${HEIGHT - PADDING_Y}`}
          fill='none'
          stroke={isDarkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)'}
          strokeWidth='1'
        />
        <path
          d={`M ${PADDING_X} ${HEIGHT / 2} L ${WIDTH - PADDING_X} ${HEIGHT / 2}`}
          fill='none'
          stroke={isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'}
          strokeDasharray='2 4'
          strokeWidth='1'
        />
        <motion.path
          d={chart.cachedPath}
          animate={{ d: chart.cachedPath }}
          transition={transition}
          fill='none'
          stroke={cachedColor}
          strokeDasharray='3 3'
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth='1.5'
        />
        <motion.path
          d={chart.totalPath}
          animate={{ d: chart.totalPath }}
          transition={transition}
          fill='none'
          stroke={totalColor}
          strokeLinecap='round'
          strokeLinejoin='round'
          strokeWidth='2'
        />
        <motion.circle
          animate={{
            cx: WIDTH - PADDING_X,
            cy: chart.totalEndY,
          }}
          transition={transition}
          fill={totalColor}
          r='2.5'
        />
      </svg>
    </div>
  )
}
