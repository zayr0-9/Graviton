import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import Editor from '@monaco-editor/react'
import type * as MonacoEditor from 'monaco-editor'
import { ensureMonacoLspBootstrap } from '../Monaco/MonacoLspBootstrap'
import type { SelectionInfo } from '../../features/ideContext'
import { resolveLanguageInfo } from '../../lib/lsp/languageIds'
import { getModel } from '../../lib/lsp/modelRegistry'
import { toFileUriString } from '../../lib/lsp/uri'
import { Button } from '../Button/button'
import { getDockTabIndicatorClasses, getDockTabKindLabel, getDockTabToneClasses } from '../dockTabStyles'

export interface MonacoPaneTabItem {
  id: string
  label: string
  title?: string
  kind?: 'file' | 'diff' | 'terminal' | 'browser'
  isDirty: boolean
  isSaving: boolean
}

interface MonacoFileEditorPaneProps {
  filePath: string | null
  relativePath?: string | null
  value: string
  loading: boolean
  error: string | null
  isDirty: boolean
  isSaving: boolean
  theme: 'vs' | 'vs-dark'
  tabs: MonacoPaneTabItem[]
  activeTabId: string | null
  onChange: (nextValue: string) => void
  onSave: () => void
  onClose: () => void
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  tabToolbar?: React.ReactNode
  statusPanel?: React.ReactNode
  onSelectionChange?: (selection: SelectionInfo | null) => void
}

ensureMonacoLspBootstrap()

export const MonacoFileEditorPane: React.FC<MonacoFileEditorPaneProps> = ({
  filePath,
  relativePath = null,
  value,
  loading,
  error,
  isDirty,
  isSaving,
  theme,
  tabs,
  activeTabId,
  onChange,
  onSave,
  onClose,
  onSelectTab,
  onCloseTab,
  tabToolbar,
  statusPanel,
  onSelectionChange,
}) => {
  const editorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null)
  const selectionListenersRef = useRef<MonacoEditor.IDisposable[]>([])
  const saveStateRef = useRef({ loading, isSaving, isDirty, onSave })
  const selectionStateRef = useRef({ filePath, relativePath, onSelectionChange })
  const lastSelectionRef = useRef<SelectionInfo | null>(null)
  const languageInfo = useMemo(() => resolveLanguageInfo(filePath), [filePath])
  const language = languageInfo.monacoLanguageId
  const modelPath = useMemo(() => (filePath ? toFileUriString(filePath) : undefined), [filePath])

  const emitCurrentSelection = useCallback(
    (
      editor: MonacoEditor.editor.IStandaloneCodeEditor | null,
      options?: { allowClear?: boolean; reason?: string }
    ) => {
      const currentEditor = editor ?? editorRef.current
      const {
        filePath: currentFilePath,
        relativePath: currentRelativePath,
        onSelectionChange: currentOnSelectionChange,
      } = selectionStateRef.current
      const allowClear = options?.allowClear ?? false
      const reason = options?.reason ?? 'unknown'

      const maybeEmitClear = (
        clearReason: string,
        details: Record<string, unknown> = {}
      ) => {
        const hasTextFocus = currentEditor?.hasTextFocus?.() ?? false
        const lastSelection = lastSelectionRef.current
        const sameFileAsLastSelection = lastSelection?.filePath === currentFilePath
        const shouldClear = allowClear && hasTextFocus && sameFileAsLastSelection

        console.log(
          shouldClear
            ? '[MonacoIdeSelection][Pane] emit null: authoritative clear'
            : '[MonacoIdeSelection][Pane] preserve previous selection: non-authoritative empty state',
          {
            reason,
            clearReason,
            allowClear,
            hasTextFocus,
            currentFilePath,
            lastSelectionFilePath: lastSelection?.filePath ?? null,
            sameFileAsLastSelection,
            ...details,
          }
        )

        if (!shouldClear) return

        lastSelectionRef.current = null
        currentOnSelectionChange?.(null)
      }

      if (!currentOnSelectionChange) {
        console.log('[MonacoIdeSelection][Pane] skip emit: no onSelectionChange handler', {
          filePath: currentFilePath,
          relativePath: currentRelativePath,
          reason,
        })
        return
      }

      if (!currentEditor || !currentFilePath) {
        maybeEmitClear('missing editor or filePath', {
          hasEditor: Boolean(currentEditor),
          relativePath: currentRelativePath,
        })
        return
      }

      const model = currentEditor.getModel()
      const selection = currentEditor.getSelection()

      if (!model || !selection) {
        maybeEmitClear('missing model or selection', {
          hasModel: Boolean(model),
          hasSelection: Boolean(selection),
        })
        return
      }

      if (selection.isEmpty()) {
        maybeEmitClear('empty selection', {
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber,
          startColumn: selection.startColumn,
          endColumn: selection.endColumn,
        })
        return
      }

      const selectedText = model.getValueInRange(selection)
      if (!selectedText.trim()) {
        maybeEmitClear('whitespace-only selection', {
          length: selectedText.length,
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber,
        })
        return
      }

      const payload: SelectionInfo = {
        filePath: currentFilePath,
        relativePath: currentRelativePath?.trim() || currentFilePath.split(/[\\/]/).pop() || currentFilePath,
        selectedText,
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        startChar: selection.startColumn,
        endChar: selection.endColumn,
        timestamp: new Date().toISOString(),
      }

      lastSelectionRef.current = payload

      console.log('[MonacoIdeSelection][Pane] emit selection', {
        reason,
        filePath: payload.filePath,
        relativePath: payload.relativePath,
        startLine: payload.startLine,
        endLine: payload.endLine,
        startChar: payload.startChar,
        endChar: payload.endChar,
        length: payload.selectedText.length,
        preview: payload.selectedText.slice(0, 120),
      })

      currentOnSelectionChange(payload)
    },
    []
  )

  useEffect(() => {
    saveStateRef.current = { loading, isSaving, isDirty, onSave }
  }, [isDirty, isSaving, loading, onSave])

  useEffect(() => {
    selectionStateRef.current = { filePath, relativePath, onSelectionChange }
  }, [filePath, relativePath, onSelectionChange])

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      editorRef.current?.layout()
      emitCurrentSelection(editorRef.current, { reason: 'lifecycle-sync' })
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [emitCurrentSelection, filePath, loading, onSelectionChange, relativePath, theme])

  useEffect(() => {
    return () => {
      selectionListenersRef.current.forEach(listener => listener.dispose())
      selectionListenersRef.current = []
    }
  }, [])

  return (
    <section className='relative flex h-full min-h-0 flex-col overflow-hidden rounded-b-2xl bg-white/70 shadow-lg backdrop-blur-sm dark:bg-neutral-950/60'>
      <div className='flex items-center gap-2 border-b border-neutral-200 px-2 py-2 dark:border-neutral-800'>
        <div className='flex min-w-0 flex-1 items-center gap-1 overflow-x-auto'>
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId
            const kindLabel = getDockTabKindLabel(tab.kind)

            return (
              <div
                key={tab.id}
                role='tab'
                aria-selected={isActive}
                tabIndex={0}
                onClick={() => onSelectTab(tab.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelectTab(tab.id)
                  }
                }}
                className={`group flex min-w-0 max-w-[220px] cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition-colors ${getDockTabToneClasses(tab.kind, isActive)}`}
                title={tab.title || tab.label}
              >
                <div className='flex min-w-0 flex-1 items-center gap-2 text-left'>
                  <span
                    className={`h-2 w-2 flex-shrink-0 rounded-full ${getDockTabIndicatorClasses(tab.kind, tab.isDirty)}`}
                  />
                  <span className='truncate'>{tab.label}</span>
                  {kindLabel ? <span className='text-[10px] opacity-70'>{kindLabel}</span> : null}
                  {tab.isSaving ? <span className='text-[10px] opacity-70'>Saving…</span> : null}
                </div>
                <button
                  type='button'
                  onClick={event => {
                    event.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  className='rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100'
                  aria-label={`Close ${tab.label}`}
                  title='Close tab'
                >
                  <i className='bx bx-x text-sm' />
                </button>
              </div>
            )
          })}
        </div>
        {tabToolbar ? <div className='flex shrink-0 items-center gap-2 pl-2'>{tabToolbar}</div> : null}
      </div>

      <header className='flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800'>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <strong className='truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100'>
              {filePath || 'File editor'}
            </strong>
            {isDirty ? (
              <span className='h-2.5 w-2.5 flex-shrink-0 rounded-full bg-amber-500' title='Unsaved changes' />
            ) : null}
          </div>
          <div className='mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400'>
            <span>{language}</span>
            <span aria-hidden='true'>•</span>
            <span>{isDirty ? 'Unsaved changes' : 'Saved'}</span>
          </div>
        </div>

        <div className='flex items-center gap-2'>
          <Button
            variant='outline2'
            size='small'
            onClick={onSave}
            disabled={!filePath || loading || isSaving || !isDirty}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant='outline2' size='small' onClick={onClose} aria-label='Close editor'>
            Close
          </Button>
        </div>
      </header>

      {error ? (
        <div className='border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200'>
          {error}
        </div>
      ) : null}

      {statusPanel ? <div className='border-b border-neutral-200 dark:border-neutral-800'>{statusPanel}</div> : null}

      <div className={`relative min-h-0 flex-1 ${theme === 'vs-dark' ? 'bg-[#1e1e1e]' : 'bg-[#ffffff]'}`}>
        <Editor
          path={modelPath}
          theme={theme}
          language={language}
          value={value}
          width='100%'
          height='100%'
          onMount={(editor, monaco) => {
            editorRef.current = editor
            const existingModel = filePath ? getModel(filePath) : null
            if (existingModel) {
              editor.setModel(existingModel)
            }
            console.log('[MonacoIdeSelection][Pane] mounted', {
              filePath,
              relativePath,
              language,
            })
            selectionListenersRef.current.forEach(listener => listener.dispose())
            selectionListenersRef.current = [
              editor.onDidChangeCursorSelection(event => {
                console.log('[MonacoIdeSelection][Pane] onDidChangeCursorSelection', {
                  filePath,
                  selectionEmpty: event.selection.isEmpty(),
                  startLine: event.selection.startLineNumber,
                  endLine: event.selection.endLineNumber,
                  startColumn: event.selection.startColumn,
                  endColumn: event.selection.endColumn,
                })
                emitCurrentSelection(editor, { allowClear: true, reason: 'cursor-selection-change' })
              }),
              editor.onMouseUp(() => {
                console.log('[MonacoIdeSelection][Pane] onMouseUp', { filePath })
                window.requestAnimationFrame(() => {
                  emitCurrentSelection(editor, { reason: 'mouse-up-sync' })
                })
              }),
              editor.onKeyUp(event => {
                console.log('[MonacoIdeSelection][Pane] onKeyUp', {
                  filePath,
                  keyCode: event.keyCode,
                })
                window.requestAnimationFrame(() => {
                  emitCurrentSelection(editor, { reason: 'key-up-sync' })
                })
              }),
            ]
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              const currentSaveState = saveStateRef.current
              if (!currentSaveState.loading && !currentSaveState.isSaving && currentSaveState.isDirty) {
                currentSaveState.onSave()
              }
            })
            window.requestAnimationFrame(() => {
              editor.layout()
              emitCurrentSelection(editor, { reason: 'mount-sync' })
            })
          }}
          onChange={next => onChange(next ?? '')}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            smoothScrolling: true,
            scrollBeyondLastLine: false,
            tabSize: 2,
            fixedOverflowWidgets: true,
            hover: {
              enabled: true,
              sticky: true,
            },
          }}
        />

        {loading ? (
          <div
            className={`absolute inset-0 flex items-center justify-center text-sm backdrop-blur-[1px] ${
              theme === 'vs-dark' ? 'bg-neutral-950/35 text-white' : 'bg-white/70 text-neutral-700'
            }`}
          >
            Loading file…
          </div>
        ) : null}
      </div>
    </section>
  )
}

export default MonacoFileEditorPane
