import React, { useMemo, useState } from 'react'

interface ReasoningCardProps {
  text: string
}

const truncateWords = (input: string, maxWords = 20): string => {
  const words = input.trim().split(/\s+/)
  if (words.length <= maxWords) return input
  return `${words.slice(0, maxWords).join(' ')}…`
}

export const ReasoningCard: React.FC<ReasoningCardProps> = ({ text }) => {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => truncateWords(text), [text])

  return (
    <div className='mobile-reasoning-card'>
      <div className='mobile-reasoning-dot' />
      <button className='mobile-reasoning-header' onClick={() => setExpanded(value => !value)}>
        <span className='mobile-reasoning-label'>Reasoning</span>
        {!expanded ? <span className='mobile-reasoning-summary'>{summary}</span> : null}
        <span className={`tool-chevron ${expanded ? 'open' : ''}`}>›</span>
      </button>

      <div className={`tool-expand-container ${expanded ? 'open' : ''}`}>
        <div className='tool-expand-content'>
          <pre className='mobile-reasoning-content'>{text}</pre>
        </div>
      </div>
    </div>
  )
}
