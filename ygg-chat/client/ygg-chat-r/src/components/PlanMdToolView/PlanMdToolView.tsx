import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Eye, Maximize2, Minus, Pencil, Plus, Save, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { localApi } from '../../utils/api'
import { SHARED_TEXT_MARKDOWN_CLASS } from '../ChatMessage/chatMessageShared'
import { motionState, useMotionPreferences } from '../motion'
import {
  getMarkdownThemeVars,
  getThemeModeColor,
  useCustomChatTheme,
  useHtmlDarkMode,
} from '../ThemeManager/themeConfig'

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

const PlanMarkdown: React.FC<{
  content: string
  className?: string
  style?: React.CSSProperties
}> = ({ content, className = '', style }) => (
  <div
    className={`${SHARED_TEXT_MARKDOWN_CLASS} !pb-0 !text-[0.8125em] sm:!text-[0.8125em] xl:!text-[0.8125em] 2xl:!text-[0.8125em] 3xl:!text-[0.8125em] ${className}`}
    style={style}
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
      {content}
    </ReactMarkdown>
  </div>
)

const iconButtonClass =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/45 text-neutral-600 backdrop-blur-xl transition-[background-color,color,transform,opacity] duration-150 hover:bg-white/80 hover:text-neutral-950 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-white/45 dark:bg-black/20 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-orange-400/70 dark:disabled:hover:bg-black/20'

export const PlanMdToolView: React.FC<PlanMdToolViewProps> = ({ args, result, className = '' }) => {
  const parsedResult = useMemo(() => parseRecord(result), [result])
  const name = toString(parsedResult.name) || toString(args?.name) || 'Plan'
  const path = toString(parsedResult.path)
  const content = toString(parsedResult.content) || toString(parsedResult.modelContent) || toString(parsedResult.message)
  const exists = parsedResult.exists !== false
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [savedContent, setSavedContent] = useState(content)
  const [draftContent, setDraftContent] = useState(content)
  const [zoom, setZoom] = useState(100)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const saveRequestIdRef = useRef(0)
  const shouldReduceMotion = useReducedMotion()
  const motionPreferences = useMotionPreferences(shouldReduceMotion)
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const isDirty = draftContent !== savedContent
  const canSave = Boolean(path && exists && isDirty && !isSaving)

  useEffect(() => {
    saveRequestIdRef.current += 1
    setSavedContent(content)
    setDraftContent(content)
    setIsSaving(false)
    setSaveError(null)
  }, [content, path])

  useEffect(() => {
    if (!isFullscreen) return
    window.requestAnimationFrame(() => closeButtonRef.current?.focus())

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isFullscreen])

  const closeFullscreen = useCallback(() => {
    saveRequestIdRef.current += 1
    setIsFullscreen(false)
    setIsEditing(false)
    setIsSaving(false)
    setSaveError(null)
  }, [])

  const requestCloseFullscreen = useCallback(() => {
    if (isDirty) {
      if (!window.confirm('Discard your unsaved plan changes?')) return
      setDraftContent(savedContent)
    }
    closeFullscreen()
  }, [closeFullscreen, isDirty, savedContent])

  const saveDraft = useCallback(async () => {
    if (!path || !exists || draftContent === savedContent || isSaving) return

    const requestId = ++saveRequestIdRef.current
    const submittedContent = draftContent
    setIsSaving(true)
    setSaveError(null)
    try {
      const response = await localApi.post<{ saved?: boolean }>('/local/file-content', {
        path,
        content: submittedContent,
      })
      if (response?.saved === false) throw new Error('Save failed')
      if (saveRequestIdRef.current === requestId) setSavedContent(submittedContent)
    } catch (error) {
      if (saveRequestIdRef.current === requestId) {
        setSaveError(error instanceof Error ? error.message : 'Failed to save plan')
      }
    } finally {
      if (saveRequestIdRef.current === requestId) setIsSaving(false)
    }
  }, [draftContent, exists, isSaving, path, savedContent])

  useEffect(() => {
    if (!isFullscreen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        requestCloseFullscreen()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveDraft()
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen, requestCloseFullscreen, saveDraft])

  if (!content) return null

  const modalSurfaceStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
      }
    : undefined
  const toolbarStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
      }
    : undefined
  const editorStyle: React.CSSProperties = {
    ...(customThemeEnabled
      ? {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
          color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
        }
      : {}),
    fontSize: `${zoom / 100}rem`,
  }
  const markdownStyle = customThemeEnabled ? getMarkdownThemeVars(customTheme, isDarkMode) : undefined
  const zoomStyle = {
    ...(markdownStyle || {}),
    '--plan-font-size': `${zoom / 100}rem`,
  } as React.CSSProperties

  const fullscreenModal = createPortal(
    <AnimatePresence onExitComplete={() => fullscreenButtonRef.current?.focus()}>
      {isFullscreen && (
        <motion.div
          key='plan-fullscreen'
          className='fixed inset-0 z-[1200] flex items-center justify-center bg-black/30 p-3 backdrop-blur-sm sm:p-6'
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={motionPreferences.feedbackTransition}
          onMouseDown={requestCloseFullscreen}
        >
          <motion.div
            ref={dialogRef}
            role='dialog'
            aria-modal='true'
            aria-label={`${name} plan`}
            className='relative flex h-[calc(100vh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white/95 backdrop-blur-xl dark:bg-yBlack-900/95 sm:h-[calc(100vh-3rem)]'
            style={modalSurfaceStyle}
            {...motionState(motionPreferences.reducedMotion, 8)}
            transition={motionPreferences.shellTransition}
            onMouseDown={event => event.stopPropagation()}
          >
            <div className='flex min-w-0 items-center justify-between gap-3 px-4 py-3 sm:px-6'>
              <div className='min-w-0'>
                <div className='flex min-w-0 items-center gap-2'>
                  <span className='shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'>
                    plan
                  </span>
                  <h2 className='min-w-0 truncate text-sm font-semibold' title={name}>
                    {name}
                  </h2>
                  {isDirty && <span className='text-[10px] text-amber-600 dark:text-amber-300' role='status'>Unsaved changes</span>}
                </div>
                {path && <p className='mt-1 truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500' title={path}>{path}</p>}
              </div>
              <div className='flex shrink-0 items-center gap-2'>
                <button
                  type='button'
                  onClick={() => setIsEditing(value => !value)}
                  className={`${iconButtonClass} ${isEditing ? 'bg-blue-50 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100' : ''}`}
                  title={isEditing ? 'Preview rendered plan' : 'Edit raw Markdown'}
                  aria-label={isEditing ? 'Preview rendered plan' : 'Edit raw Markdown'}
                  aria-pressed={isEditing}
                >
                  {isEditing ? <Eye size={18} strokeWidth={2.25} aria-hidden='true' /> : <Pencil size={18} strokeWidth={2.25} aria-hidden='true' />}
                </button>
                <button
                  ref={closeButtonRef}
                  type='button'
                  onClick={requestCloseFullscreen}
                  className={iconButtonClass}
                  title='Close fullscreen plan'
                  aria-label='Close fullscreen plan'
                >
                  <X size={18} strokeWidth={2.25} aria-hidden='true' />
                </button>
              </div>
            </div>

            <AnimatePresence mode='wait' initial={false}>
              {isEditing ? (
                <motion.div
                  key='editor'
                  className='min-h-0 flex-1 px-4 pb-24 sm:px-6'
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={motionPreferences.contentTransition}
                >
                  <textarea
                    autoFocus
                    value={draftContent}
                    onChange={event => setDraftContent(event.target.value)}
                    className='h-full w-full resize-none rounded-xl bg-neutral-100/70 p-4 font-mono leading-relaxed text-neutral-900 outline-none thin-scrollbar focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:bg-black/20 dark:text-neutral-100 dark:focus-visible:ring-orange-400/70'
                    style={editorStyle}
                    aria-label={`Edit ${name} Markdown`}
                    spellCheck={false}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key='preview'
                  className='min-h-0 flex-1 overflow-auto px-4 pb-24 pt-4 thin-scrollbar sm:px-6'
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={motionPreferences.contentTransition}
                >
                  <PlanMarkdown
                    content={draftContent}
                    className='!text-[length:var(--plan-font-size)] sm:!text-[length:var(--plan-font-size)] xl:!text-[length:var(--plan-font-size)] 2xl:!text-[length:var(--plan-font-size)] 3xl:!text-[length:var(--plan-font-size)]'
                    style={zoomStyle}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            <motion.div
              className='pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4 sm:bottom-5'
              initial={motionPreferences.reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={motionPreferences.reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              exit={motionPreferences.reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
              transition={motionPreferences.contentTransition}
            >
              <div
                className='pointer-events-auto flex w-full max-w-md items-center gap-1 rounded-full bg-white/70 p-1.5 backdrop-blur-xl dark:bg-black/35 sm:w-auto sm:gap-2'
                style={toolbarStyle}
                role='toolbar'
                aria-label='Plan viewer controls'
              >
                <button type='button' className={iconButtonClass} onClick={() => setZoom(value => Math.max(75, value - 5))} disabled={zoom <= 75} title='Zoom out' aria-label='Zoom out'>
                  <Minus size={17} strokeWidth={2.25} aria-hidden='true' />
                </button>
                <input
                  type='range'
                  min={75}
                  max={150}
                  step={5}
                  value={zoom}
                  onChange={event => setZoom(Number(event.target.value))}
                  className='min-w-0 flex-1 accent-blue-600 sm:w-36 sm:flex-none dark:accent-orange-400'
                  aria-label='Plan font size'
                  aria-valuetext={`${zoom}%`}
                />
                <span className='hidden w-9 text-center text-[10px] tabular-nums text-neutral-500 dark:text-neutral-300 sm:block' aria-hidden='true'>{zoom}%</span>
                <button type='button' className={iconButtonClass} onClick={() => setZoom(value => Math.min(150, value + 5))} disabled={zoom >= 150} title='Zoom in' aria-label='Zoom in'>
                  <Plus size={17} strokeWidth={2.25} aria-hidden='true' />
                </button>
                <div className='mx-0.5 h-5 w-px bg-neutral-300/60 dark:bg-white/10' aria-hidden='true' />
                <button
                  type='button'
                  onClick={() => void saveDraft()}
                  disabled={!canSave}
                  className='inline-flex h-9 items-center gap-1.5 rounded-full bg-blue-600 px-3 text-xs font-semibold text-white transition-[background-color,color,transform,opacity] duration-150 hover:bg-blue-700 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 disabled:opacity-70 dark:bg-orange-500 dark:text-black dark:hover:bg-orange-400 dark:focus-visible:ring-orange-400/70 dark:disabled:bg-white/10 dark:disabled:text-neutral-500'
                  title={saveError || (!path || !exists ? 'This plan cannot be saved' : isDirty ? 'Save plan' : 'No changes to save')}
                  aria-busy={isSaving}
                >
                  <Save size={16} strokeWidth={2.25} aria-hidden='true' />
                  {isSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </motion.div>
            {saveError && <p className='absolute bottom-16 left-1/2 -translate-x-1/2 rounded-full bg-red-100/90 px-3 py-1 text-xs text-red-700 backdrop-blur-xl dark:bg-red-500/15 dark:text-red-200' role='alert'>{saveError}</p>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )

  return (
    <>
      <div
        className={`min-w-0 flex-1 overflow-hidden rounded-xl border border-neutral-200/70 bg-white/55 dark:border-neutral-800/80 dark:bg-neutral-950/25 ${className}`}
      >
        <div className='flex min-w-0 items-center justify-between gap-3 px-3 py-2'>
          <div className='flex min-w-0 items-center gap-2'>
            <span className='shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'>
              plan
            </span>
            <span className='min-w-0 truncate text-xs font-semibold text-neutral-800 dark:text-neutral-100' title={name}>
              {name}
            </span>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <button
              ref={fullscreenButtonRef}
              type='button'
              onClick={() => setIsFullscreen(true)}
              className='inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-medium text-neutral-600 transition-[background-color,color,transform] duration-150 hover:bg-neutral-200 hover:text-neutral-900 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-orange-400/70'
              title='Open fullscreen plan'
              aria-label='Open fullscreen plan'
            >
              <Maximize2 size={13} strokeWidth={2.25} aria-hidden='true' />
              Fullscreen
            </button>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                exists
                  ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
              }`}
            >
              {exists ? 'displayed' : 'missing'}
            </span>
          </div>
        </div>

        {path && (
          <div className='truncate px-3 pb-2 font-mono text-[10px] text-neutral-400 dark:text-neutral-500' title={path}>
            {path}
          </div>
        )}

        <div className='max-h-[52vh] overflow-auto border-t border-neutral-200/60 px-3 py-2 dark:border-neutral-800/80 thin-scrollbar'>
          <PlanMarkdown content={savedContent} />
        </div>
      </div>
      {fullscreenModal}
    </>
  )
}

export default PlanMdToolView
