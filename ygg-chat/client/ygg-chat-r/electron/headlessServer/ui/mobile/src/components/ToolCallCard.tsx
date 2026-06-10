import React, { useEffect, useMemo, useState } from 'react'
import { Badge } from './ui'
import { EditToolDiffView } from './EditToolDiffView'
import { PlanMdToolView } from './PlanMdToolView'
import { CustomToolIframe } from './CustomToolIframe'
import type { ToolGroup, ToolResultLike } from '../types'
import { extractHtmlFromToolResult, toReadableToolResult } from '../messageParser'

const LOCAL_UI_BASE = '/api/headless/custom-tools/ui/'

const buildRemoteCustomToolUiUrl = (toolName: string | null | undefined): string | null => {
  const trimmed = String(toolName || '').trim()
  if (!trimmed) return null
  return `${LOCAL_UI_BASE}${encodeURIComponent(trimmed)}/`
}

interface ToolCallCardProps {
  group: ToolGroup
  defaultExpanded?: boolean
  currentUserId?: string | null
  rootPath?: string | null
}

interface EditFileResultLike {
  success?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const findPathHint = (args: Record<string, unknown> | undefined): string | null => {
  if (!args) return null

  if (Array.isArray(args.edits)) {
    const editPaths = args.edits
      .filter(isRecord)
      .map(edit => (typeof edit.path === 'string' ? edit.path : null))
      .filter((value): value is string => Boolean(value))

    if (editPaths.length > 0) {
      return editPaths.length === 1 ? editPaths[0] : `${editPaths[0]} +${editPaths.length - 1} more`
    }

    if (args.edits.length > 0) {
      return `${args.edits.length} edits`
    }
  }

  const key = ['path', 'filePath', 'cwd', 'searchPath'].find(candidate => typeof args[candidate] === 'string')
  if (!key) return null
  return String(args[key])
}

const parseResultObject = (content: unknown): EditFileResultLike | null => {
  if (content == null) return null
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content)
      return parsed && typeof parsed === 'object' ? (parsed as EditFileResultLike) : null
    } catch {
      return null
    }
  }
  if (typeof content === 'object') return content as EditFileResultLike
  return null
}

const normalizeToolName = (name: string | undefined): string =>
  String(name || '')
    .toLowerCase()
    .replace(/[-\s]/g, '_')

const isEditLikeTool = (name: string | undefined): boolean => {
  const normalized = normalizeToolName(name)
  return normalized === 'edit_file' || normalized === 'editfile' || normalized === 'multi_edit'
}

const isPlanMdDisplayTool = (name: string | undefined, args: Record<string, unknown> | undefined): boolean => {
  const normalized = normalizeToolName(name)
  return normalized === 'plan_md' && String(args?.action || '').toLowerCase() === 'display'
}

const humanizeToolName = (name: string | null | undefined): string => {
  const normalized = String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return 'Custom Tool'

  return normalized
    .split(' ')
    .map(token => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(' ')
}

const renderToolResult = (
  result: ToolResultLike,
  index: number,
  groupId: string,
  options: {
    currentUserId?: string | null
    rootPath?: string | null
    fallbackToolName?: string
    isIframeOpen: boolean
    isFullscreen: boolean
    onToggleIframe: () => void
    onToggleFullscreen: () => void
  }
) => {
  const htmlPayload = extractHtmlFromToolResult(result.content)

  if (htmlPayload?.html) {
    return (
      <div key={`${groupId}-result-${index}`} className={`mobile-tool-result ${result.is_error ? 'error' : 'success'}`}>
        <div className='mobile-tool-app-header'>
          <span className='mobile-tool-app-label'>HTML App Result</span>
          <div className='mobile-tool-app-actions'>
            <button type='button' className='mobile-tool-app-toggle' onClick={options.onToggleIframe}>
              {options.isIframeOpen ? 'Hide app' : 'Open app'}
            </button>
            <button
              type='button'
              className='mobile-tool-app-toggle'
              disabled={!options.isIframeOpen}
              onClick={options.onToggleFullscreen}
            >
              {options.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
          </div>
        </div>
        {options.isIframeOpen ? (
          <div className={`mobile-custom-tool-iframe-shell ${options.isFullscreen ? 'fullscreen' : ''}`}>
            {options.isFullscreen ? (
              <div className='mobile-custom-tool-fullscreen-bar'>
                <span className='mobile-custom-tool-fullscreen-title'>
                  {humanizeToolName(htmlPayload.toolName ?? options.fallbackToolName ?? null)}
                </span>
                <button
                  type='button'
                  className='mobile-custom-tool-fullscreen-close'
                  onClick={options.onToggleFullscreen}
                >
                  Close
                </button>
              </div>
            ) : null}
            <CustomToolIframe
              html={htmlPayload.html}
              src={buildRemoteCustomToolUiUrl(htmlPayload.toolName ?? options.fallbackToolName ?? null)}
              warning='This custom app may rely on desktop-only capabilities. Some actions may fail in remote/browser mode, but you can still try opening it.'
              toolName={htmlPayload.toolName ?? options.fallbackToolName ?? null}
              userId={options.currentUserId ?? null}
              rootPath={options.rootPath ?? null}
            />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div key={`${groupId}-result-${index}`} className={`mobile-tool-result ${result.is_error ? 'error' : 'success'}`}>
      <pre>{toReadableToolResult(result)}</pre>
      <span className='mobile-tool-status'>{result.is_error ? 'failed' : 'completed'}</span>
    </div>
  )
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({
  group,
  defaultExpanded = false,
  currentUserId = null,
  rootPath = null,
}) => {
  const normalizedToolName = useMemo(() => normalizeToolName(group.name), [group.name])
  const isEditTool = useMemo(() => isEditLikeTool(group.name), [group.name])
  const isPlanMdDisplay = useMemo(() => isPlanMdDisplayTool(group.name, group.args), [group.name, group.args])
  const isHtmlRendererTool = normalizedToolName === 'html_renderer'
  const editResult = useMemo(() => parseResultObject(group.results[0]?.content), [group.results])
  const hasEditToolView = isEditTool && Boolean(group.args)
  const hasPlanMdDisplayView = isPlanMdDisplay && Boolean(group.args)
  const hasHtmlResult = useMemo(() => group.results.some(result => Boolean(extractHtmlFromToolResult(result.content)?.html)), [group.results])

  const rendererHtmlFromArgs = useMemo(() => {
    if (!isHtmlRendererTool || !group.args) return ''
    const htmlValue = (group.args as Record<string, unknown>).html
    return typeof htmlValue === 'string' ? htmlValue.trim() : ''
  }, [group.args, isHtmlRendererTool])

  const displayArgs = useMemo(() => {
    if (!group.args) return undefined
    if (!isHtmlRendererTool) return group.args
    const { html: _html, ...rest } = group.args as Record<string, unknown>
    return Object.keys(rest).length > 0 ? rest : undefined
  }, [group.args, isHtmlRendererTool])

  const [expanded, setExpanded] = useState(
    defaultExpanded || hasEditToolView || hasPlanMdDisplayView || hasHtmlResult || Boolean(rendererHtmlFromArgs)
  )
  const [openIframeByResultIndex, setOpenIframeByResultIndex] = useState<Record<number, boolean>>({})
  const [fullscreenIframeByResultIndex, setFullscreenIframeByResultIndex] = useState<Record<number, boolean>>({})

  useEffect(() => {
    if (hasEditToolView || hasPlanMdDisplayView || hasHtmlResult || Boolean(rendererHtmlFromArgs)) setExpanded(true)
  }, [hasEditToolView, hasPlanMdDisplayView, hasHtmlResult, rendererHtmlFromArgs])

  useEffect(() => {
    if (!hasHtmlResult) {
      setOpenIframeByResultIndex({})
      return
    }

    setOpenIframeByResultIndex(previous => {
      const next = { ...previous }
      let changed = false

      group.results.forEach((result, index) => {
        const hasHtml = Boolean(extractHtmlFromToolResult(result.content)?.html)
        if (!hasHtml) {
          if (index in next) {
            delete next[index]
            changed = true
          }
          return
        }

        if (!(index in next)) {
          next[index] = true
          changed = true
        }
      })

      return changed ? next : previous
    })
  }, [group.results, hasHtmlResult])

  useEffect(() => {
    if (!hasHtmlResult) {
      setFullscreenIframeByResultIndex({})
      return
    }

    setFullscreenIframeByResultIndex(previous => {
      const next = { ...previous }
      let changed = false

      group.results.forEach((result, index) => {
        const hasHtml = Boolean(extractHtmlFromToolResult(result.content)?.html)
        const isOpen = openIframeByResultIndex[index] !== false
        if (!hasHtml || !isOpen) {
          if (next[index]) {
            delete next[index]
            changed = true
          }
        }
      })

      return changed ? next : previous
    })
  }, [group.results, hasHtmlResult, openIframeByResultIndex])

  useEffect(() => {
    const hasFullscreen = Object.values(fullscreenIframeByResultIndex).some(Boolean)
    if (!hasFullscreen) return

    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = originalOverflow
    }
  }, [fullscreenIframeByResultIndex])

  const pathHint = useMemo(() => findPathHint(displayArgs), [displayArgs])
  const hasError = group.results.some(result => Boolean(result.is_error)) || editResult?.success === false

  return (
    <div className='mobile-tool-card'>
      <div className={`mobile-tool-dot ${hasError ? 'error' : 'success'}`} />
      <button className='mobile-tool-header' onClick={() => setExpanded(value => !value)}>
        <Badge className='mobile-tool-chip' variant='outline'>
          {group.name || 'tool'}
        </Badge>
        {!expanded && pathHint ? <span className='mobile-tool-path'>{pathHint}</span> : null}
        <span className={`tool-chevron ${expanded ? 'open' : ''}`}>›</span>
      </button>

      <div className={`tool-expand-container ${expanded ? 'open' : ''}`}>
        <div className='tool-expand-content'>
          {hasEditToolView ? (
            <EditToolDiffView
              toolName={group.name}
              args={group.args}
              result={group.results[0]?.content ?? {}}
              className='mobile-editfile-view'
            />
          ) : hasPlanMdDisplayView ? (
            <PlanMdToolView args={group.args} result={group.results[0]?.content ?? {}} />
          ) : (
            <>
              {displayArgs && Object.keys(displayArgs).length > 0 ? (
                <div className='mobile-tool-block'>
                  {Object.entries(displayArgs).map(([key, value]) => (
                    <div key={key} className='mobile-tool-kv'>
                      <span className='mobile-tool-k'>{key}:</span>{' '}
                      <span className='mobile-tool-v'>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {isHtmlRendererTool && rendererHtmlFromArgs ? (
                <div className='mobile-tool-result success'>
                  <div className='mobile-tool-app-header'>
                    <span className='mobile-tool-app-label'>Rendered HTML</span>
                  </div>
                  <CustomToolIframe
                    html={rendererHtmlFromArgs}
                    toolName={group.name}
                    userId={currentUserId ?? null}
                    rootPath={rootPath ?? null}
                  />
                </div>
              ) : (
                group.results.map((result, index) =>
                  renderToolResult(result, index, group.id, {
                    currentUserId,
                    rootPath,
                    fallbackToolName: group.name,
                    isIframeOpen: openIframeByResultIndex[index] !== false,
                    isFullscreen: fullscreenIframeByResultIndex[index] === true,
                    onToggleIframe: () => {
                      setOpenIframeByResultIndex(previous => {
                        const nextOpen = previous[index] === false
                        if (!nextOpen) {
                          setFullscreenIframeByResultIndex(fullscreenPrev => {
                            if (!fullscreenPrev[index]) return fullscreenPrev
                            const nextFullscreen = { ...fullscreenPrev }
                            delete nextFullscreen[index]
                            return nextFullscreen
                          })
                        }
                        return {
                          ...previous,
                          [index]: nextOpen,
                        }
                      })
                    },
                    onToggleFullscreen: () =>
                      setFullscreenIframeByResultIndex(previous => ({
                        ...previous,
                        [index]: previous[index] !== true,
                      })),
                  })
                )
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
