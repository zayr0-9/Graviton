import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor, Editor } from '@monaco-editor/react'
import type * as MonacoEditor from 'monaco-editor'
import { Button } from '../Button/button'
import { getDockTabIndicatorClasses, getDockTabKindLabel, getDockTabToneClasses } from '../dockTabStyles'
import type { MonacoPaneTabItem } from '../MonacoFileEditorPane/MonacoFileEditorPane'

const DIFF_THEME_LIGHT = 'ygg-git-diff-light'
const DIFF_THEME_DARK = 'ygg-git-diff-dark'

const configureDiffTheme = (monaco: typeof MonacoEditor, baseTheme: 'vs' | 'vs-dark') => {
  const themeName = baseTheme === 'vs-dark' ? DIFF_THEME_DARK : DIFF_THEME_LIGHT

  monaco.editor.defineTheme(themeName, {
    base: baseTheme,
    inherit: true,
    rules: [],
    colors:
      baseTheme === 'vs-dark'
        ? {
            'diffEditor.insertedTextBackground': '#163a20',
            'diffEditor.removedTextBackground': '#4a1b1b',
            'diffEditor.insertedLineBackground': '#12351d',
            'diffEditor.removedLineBackground': '#451818',
            'diffEditor.diagonalFill': '#1f2937',
            'editorGutter.addedBackground': '#22c55e',
            'editorGutter.deletedBackground': '#ef4444',
            'editorOverviewRuler.addedForeground': '#22c55eaa',
            'editorOverviewRuler.deletedForeground': '#ef4444aa',
          }
        : {
            'diffEditor.insertedTextBackground': '#9be9a833',
            'diffEditor.removedTextBackground': '#ffb3ba66',
            'diffEditor.insertedLineBackground': '#d8f5dd',
            'diffEditor.removedLineBackground': '#ffe1e3',
            'diffEditor.diagonalFill': '#d4d4d8',
            'editorGutter.addedBackground': '#16a34a',
            'editorGutter.deletedBackground': '#dc2626',
            'editorOverviewRuler.addedForeground': '#16a34aaa',
            'editorOverviewRuler.deletedForeground': '#dc2626aa',
          },
  })

  return themeName
}

interface MonacoGitDiffPaneProps {
  title: string | null
  filePath: string | null
  originalValue: string
  modifiedValue: string
  originalLabel: string
  modifiedLabel: string
  loading: boolean
  error: string | null
  theme: 'vs' | 'vs-dark'
  language: string
  message?: string | null
  patch?: string | null
  preferPatch?: boolean
  tabs: MonacoPaneTabItem[]
  activeTabId: string | null
  onClose: () => void
  onOpenFile?: (() => void) | null
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  tabToolbar?: React.ReactNode
}

const getFileName = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
}

const buildPatchLineDecorations = (
  monaco: typeof MonacoEditor,
  value: string,
  baseTheme: 'vs' | 'vs-dark'
): MonacoEditor.editor.IModelDeltaDecoration[] => {
  const addedClass = baseTheme === 'vs-dark' ? 'ygg-git-patch-line-added-dark' : 'ygg-git-patch-line-added-light'
  const removedClass = baseTheme === 'vs-dark' ? 'ygg-git-patch-line-removed-dark' : 'ygg-git-patch-line-removed-light'

  return value.split('\n').flatMap((line, index) => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      return []
    }

    if (line.startsWith('+')) {
      return [
        {
          range: new monaco.Range(index + 1, 1, index + 1, 1),
          options: {
            isWholeLine: true,
            className: addedClass,
            linesDecorationsClassName:
              baseTheme === 'vs-dark' ? 'ygg-git-patch-marker-added-dark' : 'ygg-git-patch-marker-added-light',
            marginClassName: addedClass,
          },
        },
      ]
    }

    if (line.startsWith('-')) {
      return [
        {
          range: new monaco.Range(index + 1, 1, index + 1, 1),
          options: {
            isWholeLine: true,
            className: removedClass,
            linesDecorationsClassName:
              baseTheme === 'vs-dark' ? 'ygg-git-patch-marker-removed-dark' : 'ygg-git-patch-marker-removed-light',
            marginClassName: removedClass,
          },
        },
      ]
    }

    return []
  })
}

export const MonacoGitDiffPane: React.FC<MonacoGitDiffPaneProps> = ({
  title,
  filePath,
  originalValue,
  modifiedValue,
  originalLabel,
  modifiedLabel,
  loading,
  error,
  theme,
  language,
  message,
  patch,
  preferPatch = false,
  tabs,
  activeTabId,
  onClose,
  onOpenFile,
  onSelectTab,
  onCloseTab,
  tabToolbar,
}) => {
  const editorRef = useRef<MonacoEditor.editor.IStandaloneDiffEditor | null>(null)
  const patchEditorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null)
  const patchDecorationsRef = useRef<MonacoEditor.editor.IEditorDecorationsCollection | null>(null)
  const monacoRef = useRef<typeof MonacoEditor | null>(null)
  const [renderSideBySide, setRenderSideBySide] = useState(true)
  const activeTitle = useMemo(() => title || filePath || 'Git diff', [filePath, title])
  const monacoTheme = theme === 'vs-dark' ? DIFF_THEME_DARK : DIFF_THEME_LIGHT

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      editorRef.current?.layout()
      patchEditorRef.current?.layout()
    })

    return () => {
      window.cancelAnimationFrame(rafId)
    }
  }, [activeTabId, filePath, loading, theme, preferPatch, patch, renderSideBySide])

  useEffect(() => {
    if (!monacoRef.current) {
      return
    }

    configureDiffTheme(monacoRef.current, theme)
    monacoRef.current.editor.setTheme(monacoTheme)
  }, [monacoTheme, theme])

  useEffect(() => {
    if (!preferPatch || !monacoRef.current || !patchEditorRef.current) {
      return
    }

    const model = patchEditorRef.current.getModel()
    if (!model) {
      return
    }

    patchDecorationsRef.current?.clear()
    patchDecorationsRef.current = patchEditorRef.current.createDecorationsCollection(
      buildPatchLineDecorations(monacoRef.current, model.getValue(), theme)
    )
  }, [filePath, message, patch, preferPatch, theme])

  return (
    <section className='relative flex h-full min-h-0 flex-col overflow-hidden rounded-b-2xl bg-white/70 shadow-lg  backdrop-blur-sm dark:bg-neutral-950/60'>
      <style>{`
        .ygg-git-patch-line-added-light { background: #d8f5dd; }
        .ygg-git-patch-line-removed-light { background: #ffe1e3; }
        .ygg-git-patch-line-added-dark { background: #12351d; }
        .ygg-git-patch-line-removed-dark { background: #451818; }
        .ygg-git-patch-marker-added-light, .ygg-git-patch-marker-added-dark {
          border-left: 3px solid #22c55e;
          margin-left: 4px;
        }
        .ygg-git-patch-marker-removed-light, .ygg-git-patch-marker-removed-dark {
          border-left: 3px solid #ef4444;
          margin-left: 4px;
        }
      `}</style>
      <div className='flex items-center gap-2 border-b border-neutral-200 px-2 py-2 dark:border-neutral-800'>
        <div className='flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden thin-scrollbar'>
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
                className={`group flex w-[240px] min-w-0 shrink-0 cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs transition-colors ${getDockTabToneClasses(tab.kind, isActive)}`}
                title={tab.title || tab.label}
              >
                <div className='flex min-w-0 flex-1 items-center gap-2 text-left'>
                  <span
                    className={`h-2 w-2 flex-shrink-0 rounded-full ${getDockTabIndicatorClasses(tab.kind, tab.isDirty)}`}
                  />
                  <span className='truncate'>{tab.label}</span>
                  {kindLabel ? <span className='shrink-0 whitespace-nowrap text-[10px] opacity-70'>{kindLabel}</span> : null}
                  {tab.isSaving ? <span className='shrink-0 whitespace-nowrap text-[10px] opacity-70'>Saving…</span> : null}
                </div>
                <button
                  type='button'
                  onClick={event => {
                    event.stopPropagation()
                    onCloseTab(tab.id)
                  }}
                  className='shrink-0 rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100'
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
              {activeTitle}
            </strong>
            <span className='rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200'>
              Git Diff
            </span>
          </div>
          <div className='mt-0.5 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400'>
            <span>{language}</span>
            <span aria-hidden='true'>•</span>
            <span>{originalLabel}</span>
            <span aria-hidden='true'>→</span>
            <span>{modifiedLabel}</span>
          </div>
          {filePath ? (
            <div className='mt-1 truncate text-[11px] text-neutral-500 dark:text-neutral-400' title={filePath}>
              {getFileName(filePath)}
            </div>
          ) : null}
        </div>

        <div className='flex items-center gap-2'>
          {!preferPatch && (
            <Button
              variant='outline2'
              size='small'
              onClick={() => setRenderSideBySide(current => !current)}
              aria-label='Toggle diff layout'
            >
              {renderSideBySide ? 'Inline' : 'Side by side'}
            </Button>
          )}
          {onOpenFile && filePath && (
            <Button variant='outline2' size='small' onClick={onOpenFile} aria-label='Open file from diff'>
              Open file
            </Button>
          )}
          <Button variant='outline2' size='small' onClick={onClose} aria-label='Close diff viewer'>
            Close
          </Button>
        </div>
      </header>

      {error ? (
        <div className='border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200'>
          {error}
        </div>
      ) : null}

      {message ? (
        <div className='border-b border-neutral-200 bg-neutral-50/80 px-4 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-300'>
          {message}
        </div>
      ) : null}

      <div className={`relative min-h-0 flex-1 ${theme === 'vs-dark' ? 'bg-[#1e1e1e]' : 'bg-[#ffffff]'}`}>
        {!preferPatch ? (
          <DiffEditor
            key={`${filePath || 'git-diff'}-${theme}-${renderSideBySide ? 'split' : 'inline'}`}
            original={originalValue}
            modified={modifiedValue}
            theme={monacoTheme}
            language={language}
            beforeMount={monaco => {
              monacoRef.current = monaco
              configureDiffTheme(monaco, theme)
              monaco.editor.setTheme(monacoTheme)
            }}
            width='100%'
            height='100%'
            onMount={(editor, monaco) => {
              monacoRef.current = monaco
              editorRef.current = editor
              configureDiffTheme(monaco, theme)
              monaco.editor.setTheme(monacoTheme)
              window.requestAnimationFrame(() => editor.layout())
            }}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: 'on',
              smoothScrolling: true,
              scrollBeyondLastLine: false,
              readOnly: true,
              originalEditable: false,
              renderSideBySide,
              enableSplitViewResizing: true,
              renderIndicators: true,
              diffWordWrap: 'on',
              renderOverviewRuler: true,
            }}
          />
        ) : (
          <Editor
            key={`${filePath || 'git-diff-patch'}-${theme}`}
            theme={monacoTheme}
            language='diff'
            value={patch || message || 'No diff available.'}
            beforeMount={monaco => {
              monacoRef.current = monaco
              configureDiffTheme(monaco, theme)
              monaco.editor.setTheme(monacoTheme)
            }}
            onMount={(editor, monaco) => {
              monacoRef.current = monaco
              patchEditorRef.current = editor
              configureDiffTheme(monaco, theme)
              monaco.editor.setTheme(monacoTheme)
              const model = editor.getModel()
              if (model) {
                patchDecorationsRef.current?.clear()
                patchDecorationsRef.current = editor.createDecorationsCollection(
                  buildPatchLineDecorations(monaco, model.getValue(), theme)
                )
              }
              window.requestAnimationFrame(() => editor.layout())
            }}
            width='100%'
            height='100%'
            options={{
              readOnly: true,
              glyphMargin: true,
              lineDecorationsWidth: 10,
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: 'on',
              smoothScrolling: true,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        )}

        {loading ? (
          <div
            className={`absolute inset-0 flex items-center justify-center text-sm backdrop-blur-[1px] ${
              theme === 'vs-dark' ? 'bg-neutral-950/35 text-white' : 'bg-white/70 text-neutral-700'
            }`}
          >
            Loading diff…
          </div>
        ) : null}
      </div>
    </section>
  )
}

export default MonacoGitDiffPane
