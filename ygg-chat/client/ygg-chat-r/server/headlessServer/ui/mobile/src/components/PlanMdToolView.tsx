import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'

interface PlanMdToolViewProps {
  args?: Record<string, unknown> | null
  result: unknown
  className?: string
}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseRecord = (raw: unknown): UnknownRecord => {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return isRecord(parsed) ? parsed : { content: raw }
    } catch {
      return { content: raw }
    }
  }
  return isRecord(raw) ? raw : {}
}

const toString = (value: unknown): string => (typeof value === 'string' ? value : '')

export const PlanMdToolView: React.FC<PlanMdToolViewProps> = ({ args, result, className = '' }) => {
  const parsedResult = useMemo(() => parseRecord(result), [result])

  const name = toString(parsedResult.name) || toString(args?.name) || 'Plan'
  const path = toString(parsedResult.path)
  const content = toString(parsedResult.content) || toString(parsedResult.modelContent) || toString(parsedResult.message)
  const exists = parsedResult.exists !== false

  if (!content) return null

  return (
    <div className={`mobile-planmd-root ${className}`}>
      <div className='mobile-planmd-head'>
        <div className='mobile-planmd-title-wrap'>
          <span className='mobile-planmd-label'>plan</span>
          <span className='mobile-planmd-title' title={name}>
            {name}
          </span>
        </div>
        <span className={`mobile-planmd-status ${exists ? 'success' : 'error'}`}>{exists ? 'displayed' : 'missing'}</span>
      </div>
      {path ? <div className='mobile-planmd-path'>{path}</div> : null}
      <div className='mobile-planmd-body markdown-body'>
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  )
}

export default PlanMdToolView
