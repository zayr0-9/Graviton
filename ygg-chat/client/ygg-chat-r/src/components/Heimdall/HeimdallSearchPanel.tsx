import { Bot, Search, User, X } from 'lucide-react'
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { getActionPopoverThemeStyle } from '../ActionPopover/actionPopoverTheme'
import { useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import {
  HEIMDALL_SEARCH_ROLES,
  heimdallSearchRoleOf,
  searchHeimdallMessages,
  tokenizeHeimdallSearch,
  type HeimdallSearchResult,
  type HeimdallSearchRole,
  type HeimdallSearchSource,
} from './heimdallSearch'
import './heimdallSearchPanel.css'

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const ROLE_LABELS: Record<Exclude<HeimdallSearchRole, 'all'>, string> = { user: 'User', assistant: 'Assistant' }

export interface HeimdallSearchPanelProps {
  messages: readonly HeimdallSearchSource[]
  query: string
  onQueryChange: (query: string) => void
  role: HeimdallSearchRole
  onRoleChange: (role: HeimdallSearchRole) => void
  onSelect: (result: HeimdallSearchResult) => void
  onClose: () => void
}

export const HeimdallSearchPanel: React.FC<HeimdallSearchPanelProps> = ({
  messages,
  query,
  onQueryChange,
  role,
  onRoleChange,
  onSelect,
  onClose,
}) => {
  const isDarkMode = useHtmlDarkMode()
  const { theme, enabled: customThemeEnabled } = useCustomChatTheme()
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const { results, counts } = useMemo(() => searchHeimdallMessages(messages, query, role), [messages, query, role])
  const hasQuery = query.trim().length > 0

  useEffect(() => setActiveIndex(-1), [query, role])

  useEffect(() => {
    if (activeIndex < 0) return
    resultsRef.current
      ?.querySelector<HTMLElement>(`[data-result-index='${activeIndex}']`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const highlight = useMemo(() => {
    const tokens = tokenizeHeimdallSearch(query)
    if (!tokens.length) return null
    const lower = new Set(tokens.map(token => token.toLowerCase()))
    const regex = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi')
    return (text: string) =>
      text.split(regex).map((part, idx) =>
        lower.has(part.toLowerCase()) ? <mark key={idx}>{part}</mark> : <React.Fragment key={idx}>{part}</React.Fragment>
      )
  }, [query])

  const selectRole = useCallback(
    (next: HeimdallSearchRole) => {
      onRoleChange(next)
      inputRef.current?.focus()
    },
    [onRoleChange]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(prev => Math.min(prev + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(prev => Math.max(-1, prev - 1))
    } else if (e.key === 'Enter') {
      const item = results[activeIndex >= 0 ? activeIndex : 0]
      if (item) onSelect(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const shellStyle = customThemeEnabled ? getActionPopoverThemeStyle(theme, isDarkMode) : undefined

  const filteredOut = hasQuery && results.length === 0 && counts.all > 0
  const roleLabel = role === 'all' ? '' : `${ROLE_LABELS[role].toLowerCase()} `

  return (
    <div
      className='absolute inset-0 z-30 flex items-center justify-center'
      onClick={onClose}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        className='heimdall-search'
        style={shellStyle}
        onClick={e => e.stopPropagation()}
        data-heimdall-wheel-exempt='true'
      >
        <h3 id={titleId} className='sr-only'>
          Search messages
        </h3>
        <div className='heimdall-search-header'>
          <label className='heimdall-search-field'>
            <Search size={18} strokeWidth={2.25} aria-hidden='true' />
            <input
              ref={inputRef}
              type='text'
              value={query}
              onChange={e => onQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder='Search messages'
              aria-label='Search messages'
              aria-controls={`${titleId}-results`}
              autoFocus
              spellCheck={false}
            />
            {hasQuery && (
              <button
                type='button'
                className='heimdall-search-icon-button heimdall-search-clear'
                onClick={() => {
                  onQueryChange('')
                  inputRef.current?.focus()
                }}
                title='Clear search'
                aria-label='Clear search'
              >
                <X size={16} strokeWidth={2.25} />
              </button>
            )}
          </label>
          <button
            type='button'
            className='heimdall-search-icon-button heimdall-search-close'
            onClick={onClose}
            title='Close search'
            aria-label='Close search'
          >
            <X size={18} strokeWidth={2.25} />
          </button>
        </div>

        <div className='heimdall-search-toolbar'>
          <div className='heimdall-search-roles' role='group' aria-label='Filter by role'>
            {HEIMDALL_SEARCH_ROLES.map(option => (
              <button
                key={option.value}
                type='button'
                className='heimdall-search-role'
                aria-pressed={role === option.value}
                onClick={() => selectRole(option.value)}
              >
                {option.label}
                {hasQuery && <span className='heimdall-search-role-count'>{counts[option.value]}</span>}
              </button>
            ))}
          </div>
          {hasQuery && (
            <span className='heimdall-search-summary' aria-live='polite'>
              {`${results.length} ${roleLabel}result${results.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>

        <div
          ref={resultsRef}
          id={`${titleId}-results`}
          className='heimdall-search-results thin-scrollbar'
          data-heimdall-wheel-exempt='true'
        >
          {!hasQuery && <div className='heimdall-search-empty'>Type to search this conversation.</div>}
          {hasQuery && results.length === 0 && (
            <div className='heimdall-search-empty'>
              <span>{filteredOut ? `No ${roleLabel}matches.` : 'No matches found.'}</span>
              {filteredOut && (
                <button type='button' onClick={() => selectRole('all')}>
                  {`Show all ${counts.all} match${counts.all === 1 ? '' : 'es'}`}
                </button>
              )}
            </div>
          )}
          {results.length > 0 && (
            <div className='heimdall-search-grid'>
              {results.map((item, idx) => {
                const group = heimdallSearchRoleOf(item.role)
                const RoleIcon = group === 'user' ? User : Bot
                const text = item.plain.trim() || '(empty message)'
                return (
                  <button
                    key={item.id}
                    type='button'
                    data-result-index={idx}
                    data-active={idx === activeIndex}
                    className='heimdall-search-card'
                    onClick={() => onSelect(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <span className='heimdall-search-card-meta'>
                      <span className='heimdall-search-badge'>
                        <RoleIcon size={13} strokeWidth={2.25} aria-hidden='true' />
                        {group ? ROLE_LABELS[group] : item.role ? item.role.charAt(0).toUpperCase() + item.role.slice(1) : 'Message'}
                      </span>
                      <span>#{idx + 1}</span>
                    </span>
                    <span className='heimdall-search-card-body thin-scrollbar'>{highlight ? highlight(text) : text}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
